// useSalesSync — domain hook that owns /sales.
//
// Third PR in the domain-split refactor. Same shape as
// useAccountsSync (PR #51) and useDeliveriesSync (PR #52).
//
// Why /sales is the simplest extraction so far:
//   - Already excluded from App.jsx's bulk-write loop after the
//     "stripePaymentMethodId / schedule slice status got clobbered"
//     incident (server-owned fields race the dashboard).
//   - Sale.jsx already uses fbSetAsync for both create and delete
//     — no deleteSale helper needed in the hook.
//   - Server endpoints (stripe-webhook, charge-sale-balance,
//     reconcile-sale-payments, create-checkout-session) write
//     directly via firebase-admin and bypass this hook entirely.
//     The local listener picks up server-applied state with the
//     usual recentlyWroteTo guard for the (rare) case where the
//     dashboard wrote the same record at the same instant.
//
// Listener applies the same Object.values + id-filter transform
// App.jsx used to do inline so the array-shape contract for
// downstream Sale.jsx stays identical.

import { useState, useEffect, useRef } from "react";
import { fbListen, recentlyWroteTo, onFB } from "../firebase";

export function useSalesSync() {
  const [sales, setSales] = useState([]);
  const firstFireRef = useRef(false);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/sales",
        (data) => {
          const isInitial = !firstFireRef.current;
          firstFireRef.current = true;
          if (!isInitial && recentlyWroteTo("/sales")) return;
          // Defensive: Firebase fires null on transient
          // disconnects; treat as no-op rather than wiping local
          // state. Empty Firebase resolves to an actual empty
          // object/array, never null.
          if (data == null) return;
          setSales(Object.values(data).filter(s => s && s.id));
        },
        (err) => console.error("useSalesSync listener denied:", err)
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch { /* noop */ }
    };
  }, []);

  return { sales, setSales };
}
