// Copado AI (AI Context Hub MCP server) as a fleet agent.
//
// copado-ai.delivery  deploy.validate / deploy.promote through copado_cicd_promote_user_story
//                     (execute_promotion + execute_deployment, with deployment_dry_run for validation)
//
// Ranked after agentia.delivery: when the Agentia CLI works, Agentia is used (it adds back-promotion
// sync and local quality gates). This adapter is the path when Agentia is not installed or set up.

import type { AgentAdapter, AgentDescriptor, AgentResult, Capability, ExecutionContext } from '../core/types.ts';
import type { DeliveryInput, DeliveryStep } from './externalAgents.ts';
import { COPADO_AI_TOOLS, CopadoMcpClient, fillArgs, promotionRef, storyRecords } from '../copado/mcpClient.ts';

// Argument names as Copado AI's MCP server declares them (seen on a live account, Oct 2026):
//   copado_cicd_list_user_stories   limit, search, search_field, search_value, include_details, omit_nulls
//   copado_cicd_promote_user_story  user_stories, promotion_id, source_environment_id, project_id,
//                                   execute_promotion, execute_deployment, deployment_dry_run, is_back_promotion, …
//   copado_cicd_deploy_promotion    promotion_id*, deployment_dry_run, …
// The patterns also accept close variants; a required argument that can't be filled stops the call.
const STORIES = /^(user_?stor(y|ies))(_?(ids?|names?))?$|^stor(y|ies)(_?ids?)?$/i;
const PROMOTION = /^promotion(_?(record_?)?(id|name))?$/i;

export class CopadoAiDeliveryAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: 'copado-ai.delivery',
    name: 'Copado AI MCP delivery (promote with validation or deployment)',
    provider: 'Copado AI Context Hub',
    capabilities: ['deploy.validate', 'deploy.promote'],
    mechanism: 'mcp',
    inputSchema: 'DeliveryInput',
    outputSchema: 'DeliveryStep[]',
    permissions: { write: true, deploy: true, network: true },
    costTier: 'low',
    latencyTier: 'high',
    preference: 2,
    restrictions: [
      'used only when the Agentia CLI is not available; never after an Agentia delivery failed',
      'validate = promotion with deployment_dry_run; deploy needs an approval given with --allow-deploy',
      'no back-promotion sync or local gates (Agentia does those); Copado quality gates still apply',
      'Copado runs the promotion and deployment as jobs: the result means submitted; track the job in Copado',
    ],
    docs: 'https://docs.copado.com/articles/#!copadoai-publication/copado-ai-mcp-server',
  };
  private readonly client: CopadoMcpClient;
  constructor(client = new CopadoMcpClient()) {
    this.client = client;
  }
  async isAvailable() {
    if (!this.client.configured) return { ok: false, reason: this.client.reason };
    return this.client.available();
  }

  private async storyRef(name: string): Promise<{ name: string; id?: string }> {
    try {
      const list = await this.client.tool(COPADO_AI_TOOLS.listStories);
      const props = Object.keys(list.inputSchema?.properties ?? {});
      const hints = props.includes('search_field') && props.includes('search_value')
        ? [{ key: /^search_field$/, value: 'Name' }, { key: /^search_value$/, value: name }]
        : [{ key: /^(search|query|name)$/i, value: name }];
      const args = fillArgs({ ...list, inputSchema: { ...list.inputSchema, required: [] } }, [...hints, { key: /^omit_nulls$/, value: true }]);
      return storyRecords(await this.client.call(list.name, args)).find((s) => s.name === name) ?? { name };
    } catch {
      return { name };
    }
  }

  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult<DeliveryStep[]>> {
    if (capability !== 'deploy.promote' && capability !== 'deploy.validate') return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    if (!ctx.approvalId) return { ok: false, evidence: 'none', error: 'refused: no human approval for this plan' };
    const d = input as DeliveryInput;
    const deploy = capability === 'deploy.promote';
    const evidence = deploy ? 'copado-deployment' as const : 'copado-validation' as const;
    const what = deploy ? 'promote + deploy' : 'promote + validate (dry-run deployment)';
    if (ctx.dryRun) {
      return {
        ok: true,
        evidence: 'none',
        via: 'Copado AI MCP',
        output: [{ step: what, command: `${COPADO_AI_TOOLS.promote} user_stories=[${d.copadoStory}] execute_promotion=true execute_deployment=true deployment_dry_run=${!deploy}`, ok: true, output: 'dry-run: not sent' }],
      };
    }

    const steps: DeliveryStep[] = [];
    const fail = (step: string, command: string, e: unknown): AgentResult<DeliveryStep[]> => {
      steps.push({ step, command, ok: false, error: (e as Error).message });
      return { ok: false, evidence, output: steps, error: `${step} failed: ${(e as Error).message}`, via: 'Copado AI MCP' };
    };

    const story = await this.storyRef(d.copadoStory);
    const promoteCmd = `${COPADO_AI_TOOLS.promote} ${story.name}${story.id ? ` (${story.id})` : ''}`;
    let promote;
    try {
      promote = await this.client.tool(COPADO_AI_TOOLS.promote);
    } catch (e) {
      return fail(what, promoteCmd, e);
    }
    const props = promote.inputSchema?.properties ?? {};
    const storyKey = Object.keys(props).find((k) => STORIES.test(k));
    if (!storyKey) return fail(what, promoteCmd, new Error(`${promote.name} has no user-story argument this fleet recognizes (${Object.keys(props).join(', ')}). Nothing was sent.`));
    const chained = 'execute_deployment' in props;
    let args: Record<string, unknown>;
    try {
      args = fillArgs(promote, [
        { key: new RegExp(`^${storyKey}$`), value: story.id ?? story.name },
        { key: /^execute_promotion$/, value: true },
        { key: /^execute_deployment$/, value: true },
        { key: /^deployment_dry_run$/, value: !deploy },
        { key: /^is_back_promotion$/, value: false },
      ]);
    } catch (e) {
      return fail(what, promoteCmd, e);
    }
    if (!chained && !deploy && !('deployment_dry_run' in props)) {
      return fail(what, promoteCmd, new Error('this Copado AI server offers no dry-run deployment; validation needs Agentia. Nothing was sent.'));
    }

    let promotion: string | undefined;
    try {
      ctx.log('copado-ai.promote', { story: story.name, approvalId: ctx.approvalId, dryRunDeployment: !deploy, args: Object.keys(args) });
      const out = await this.client.call(promote.name, args);
      promotion = promotionRef(out);
      steps.push({ step: chained ? `${what} submitted` : 'promote user story', command: promoteCmd, ok: true, output: out });
    } catch (e) {
      return fail(what, promoteCmd, e);
    }

    if (!chained) {
      // Older shape: promote first, then deploy the promotion it created.
      if (!promotion) return { ok: false, evidence, output: steps, error: 'promote returned no promotion id; deploy it from Copado', via: 'Copado AI MCP' };
      const deployCmd = `${COPADO_AI_TOOLS.deployPromotion} ${promotion}`;
      try {
        const tool = await this.client.tool(COPADO_AI_TOOLS.deployPromotion);
        const dargs = fillArgs(tool, [{ key: PROMOTION, value: promotion }, { key: /^deployment_dry_run$/, value: !deploy }]);
        ctx.log('copado-ai.deploy', { story: story.name, promotion, approvalId: ctx.approvalId, dryRunDeployment: !deploy });
        steps.push({ step: deploy ? 'deploy promotion submitted' : 'validate promotion submitted', command: deployCmd, ok: true, output: await this.client.call(tool.name, dargs) });
      } catch (e) {
        return fail('deploy promotion', deployCmd, e);
      }
    }
    steps.push({ step: 'track the job', command: promotion ? `Copado promotion ${promotion}` : 'Copado promotions for this story', ok: true, output: 'Copado runs this as a job; check its result in Copado (or ask Claude to call copado_cicd_analyze_job_execution) before the next wave.' });
    return { ok: true, evidence, output: steps, via: 'Copado AI MCP' };
  }
}

/** In-flight stories from Copado AI (copado_cicd_list_user_stories). */
export async function listStoriesViaCopadoAi(client: CopadoMcpClient): Promise<{ name: string; id?: string; title?: string }[]> {
  const tool = await client.tool(COPADO_AI_TOOLS.listStories);
  return storyRecords(await client.call(tool.name, fillArgs({ ...tool, inputSchema: { ...tool.inputSchema, required: [] } }, [{ key: /^limit$/, value: 200 }, { key: /^omit_nulls$/, value: true }])));
}
