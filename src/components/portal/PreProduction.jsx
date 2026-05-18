import { Label, BtnPrimary, Icon } from "./ui";

// socialOrganic → embed the existing, already client-safe ClientReview
// cockpit (the exact experience /p/{shortId} serves in production today,
// same data exposure) via an iframe of its public route — no risky
// refactor, no new data path. metaAds → clean "opens in a new tab"
// deep-link (full in-portal parity is Milestone 2).
export function PreProduction({ preproduction, narrow }) {
  if (!preproduction || !preproduction.available) {
    return (
      <div style={{ padding: narrow ? "40px 20px" : "64px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", color: "var(--text-3)" }}><Icon.doc /></div>
        <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "var(--heading)" }}>Pre-production not started yet</h3>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
          When we kick off scripting and brand direction for this project, your review will appear right here.
        </p>
      </div>
    );
  }

  if (!preproduction.embeddable) {
    // metaAds — deep-link out to the existing public review page.
    return (
      <div style={{ padding: narrow ? "40px 20px" : "64px 40px", maxWidth: 560, margin: "0 auto", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", color: "var(--accent)" }}><Icon.doc /></div>
        <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "var(--heading)" }}>Your ad scripts are ready to review</h3>
        <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
          The Meta ads pre-production review opens in its own focused page so you can read every script and leave notes with room to think.
        </p>
        {preproduction.url
          ? <a href={preproduction.url} target="_blank" rel="noopener" style={{ textDecoration: "none", display: "inline-block" }}>
              <BtnPrimary style={{ height: 48, padding: "0 22px" }}>
                Open pre-production review <Icon.external />
              </BtnPrimary>
            </a>
          : <Label color="var(--text-3)">Review link is being prepared - check back shortly.</Label>}
      </div>
    );
  }

  // socialOrganic — embed the proven cockpit by its public route.
  const src = preproduction.url || (preproduction.shortId ? `/p/${preproduction.shortId}` : null);
  if (!src) {
    return (
      <div style={{ padding: "64px 40px", textAlign: "center", color: "var(--text-3)" }}>
        Review link is being prepared - check back shortly.
      </div>
    );
  }
  return (
    <div style={{ padding: narrow ? "0" : "0", background: "var(--bg)" }}>
      <iframe
        title="Pre-production review"
        src={src}
        style={{ width: "100%", height: narrow ? "calc(100vh - 200px)" : "calc(100vh - 220px)", minHeight: 560, border: "0", display: "block" }}
      />
    </div>
  );
}
