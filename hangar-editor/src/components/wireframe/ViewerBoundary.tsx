import { Component, type ReactNode } from 'react';

/**
 * Catches a failed wireframe viewer — its lazy chunk 404ing after a deploy, or a
 * render-time throw — so the panel can fall back to the render. No three.js here.
 */
export class ViewerBoundary extends Component<{ children: ReactNode; onError(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
