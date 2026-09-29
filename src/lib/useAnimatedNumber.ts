import { useEffect, useRef, useState } from 'react';

// Anima la transición visual entre un valor real y el siguiente (ease-out
// cúbico) — no inventa mediciones intermedias, solo suaviza cómo se
// *muestra* el cambio entre dos lecturas reales. Así se siente "en vivo"
// aunque el dato de fondo (GPS) solo llegue cada varios segundos.
export function useAnimatedNumber(target: number | null, durationMs = 800): number | null {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) {
      setDisplay(null);
      fromRef.current = null;
      return;
    }

    const targetValue = target;
    const from = fromRef.current ?? targetValue;
    const start = performance.now();

    function step(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (targetValue - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = targetValue;
      }
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}
