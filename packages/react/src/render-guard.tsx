import { Component, type ErrorInfo, type ReactNode } from "react";

declare global { var __FULCRUM_DEV__: boolean | undefined; }

const viteDevelopment = typeof (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env === "object"
  ? (import.meta as ImportMeta & { env: { DEV?: boolean } }).env.DEV
  : undefined;
export const development = globalThis.__FULCRUM_DEV__ === undefined ? viteDevelopment !== false : globalThis.__FULCRUM_DEV__;

type Props = {
  children: ReactNode;
  fallback: ReactNode | ((retry: () => void) => ReactNode);
  onError(error: unknown, info: ErrorInfo): void;
  resetKey: unknown;
};
type State = { failed: boolean; resetKey: unknown };

/** Contains descendant render failures, and retries only after its caller's content identity changes. */
export class RenderGuard extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };
  private reported = false;

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!this.reported) {
      this.reported = true;
      this.props.onError(error, info);
    }
  }
  retry = () => this.setState({ failed: false, resetKey: this.props.resetKey });
  render() {
    if (!this.state.failed) return this.props.children;
    return typeof this.props.fallback === "function" ? this.props.fallback(this.retry) : this.props.fallback;
  }
}
