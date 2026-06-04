declare module '@agent-relay/sdk/workflows' {
  type AgentOptions = {
    cli: string;
    preset?: string;
    role?: string;
    retries?: number;
    maxTokens?: number;
  };

  type StepOptions = Record<string, unknown>;

  type WorkflowBuilder = {
    description(value: string): WorkflowBuilder;
    pattern(value: string): WorkflowBuilder;
    timeout(value: number): WorkflowBuilder;
    agent(name: string, options: AgentOptions): WorkflowBuilder;
    step(name: string, options: StepOptions): WorkflowBuilder;
    run(): Promise<unknown>;
  };

  export function workflow(name: string): WorkflowBuilder;
}
