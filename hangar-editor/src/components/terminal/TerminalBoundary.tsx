import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a failed Terminal view (typically its lazy chunk 404ing after a deploy,
 * or a network blip) so the rest of the page keeps rendering; `onError` lets the
 * page fall back to the Classic view.
 */
export class TerminalBoundary extends Component<{ children: ReactNode; onError(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Terminal view failed to load', error, info.componentStack);
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
