import { Sim } from './simulate.js';
import '@smithers-orchestrator/driver/WorkflowDefinition';
import '@smithers-orchestrator/graph';

type MatcherContext = {
    isNot?: boolean;
};
type MatcherResult = {
    pass: boolean;
    message: () => string;
};
type SimLike = Sim | {
    executed?: readonly string[];
    status?: string;
};
declare function toHaveExecuted(this: MatcherContext | void, received: SimLike, ids: string[]): MatcherResult;
declare function toHaveExecutedInOrder(this: MatcherContext | void, received: SimLike, ids: string[]): MatcherResult;
declare function toHaveFinished(this: MatcherContext | void, received: SimLike): MatcherResult;
declare const simMatchers: {
    toHaveExecuted: typeof toHaveExecuted;
    toHaveExecutedInOrder: typeof toHaveExecutedInOrder;
    toHaveFinished: typeof toHaveFinished;
};
declare module "bun:test" {
    interface Matchers<T> {
        toHaveExecuted(ids: string[]): void;
        toHaveExecutedInOrder(ids: string[]): void;
        toHaveFinished(): void;
    }
}

export { simMatchers, toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };
