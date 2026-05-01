// Catches render-time throws below it so an uncaught error in any
// component doesn't unmount the whole app and leave a blank page —
// historically the symptom we'd see after the dashboard sat idle and
// Firebase re-fired data with a slightly different shape on token
// refresh. The fallback prints the error + stack so we can fix the
// root cause when one shows up.
import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info?.componentStack);
    this.setState({ info });
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;

    const { label = "this view" } = this.props;
    const msg = this.state.error?.message || String(this.state.error);
    const stack = this.state.info?.componentStack || this.state.error?.stack || "";

    return (
      <div style={{
        padding: 24, margin: 16,
        background: "var(--card, #1A2236)",
        border: "1px solid var(--border, #2A3450)",
        borderRadius: 12,
        color: "var(--fg, #E5E7EB)",
        fontSize: 13, lineHeight: 1.5,
      }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: "#FCA5A5", marginBottom: 8,
        }}>
          Something broke in {label}.
        </div>
        <div style={{ marginBottom: 12, color: "var(--muted, #94A3B8)" }}>
          Other tabs should still work. Try the button below first; if it
          keeps happening, copy the error and send it to Jeremy.
        </div>
        <div style={{
          padding: 10, marginBottom: 12,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 6,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 240, overflow: "auto",
        }}>
          {msg}
          {stack && <div style={{ opacity: 0.6, marginTop: 8 }}>{stack}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={this.reset}
            style={{
              padding: "6px 12px", borderRadius: 6, border: "none",
              background: "var(--accent, #6366F1)", color: "#fff",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "6px 12px", borderRadius: 6,
              border: "1px solid var(--border, #2A3450)",
              background: "transparent", color: "var(--fg, #E5E7EB)",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
