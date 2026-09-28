import type { PersonaColor } from "@amc/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { PERSONA_HEX, shade } from "../util/theme";
import { generateSprite, isBandRow, SPRITE_SIZE } from "./generator";

export type SpriteState = "idle" | "working" | "waiting" | "alarm" | "offline";

interface Props {
  seed: number;
  color: PersonaColor;
  /** Overrides the persona colour; crew sprites pass a lighter tint of their parent's. */
  hex?: string;
  /** Rendered size in CSS px. The canvas stays 12x12 and is scaled with image-rendering: pixelated. */
  size?: number;
  state?: SpriteState;
  /** Tiny log sprites do not animate; dozens of timers for 16px icons is silly. */
  animate?: boolean;
  title?: string;
}

export function Sprite({
  seed,
  color,
  hex,
  size = 48,
  state = "idle",
  animate = true,
  title,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frames = useMemo(() => generateSprite(seed), [seed]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => setTick((t) => t + 1), 700);
    return () => clearInterval(id);
  }, [animate]);

  // Blink briefly every ~5s; waiting stations stare at you instead.
  const frame = state === "waiting" ? frames.open : tick % 7 === 6 ? frames.blink : frames.open;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const base = hex ?? PERSONA_HEX[color];
    const band = shade(base, 0.7);
    ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      if (!v) continue;
      ctx.fillStyle = v === 2 ? "#ffffff" : isBandRow(i) ? band : base;
      ctx.fillRect(i % SPRITE_SIZE, Math.floor(i / SPRITE_SIZE), 1, 1);
    }
  }, [frame, color, hex]);

  return (
    <span
      className="sprite"
      data-state={state}
      style={{ width: size, height: size }}
      title={title}
      role="img"
      aria-label={title ?? "operator sprite"}
    >
      <canvas ref={canvasRef} width={SPRITE_SIZE} height={SPRITE_SIZE} />
      {state === "waiting" && (
        <span className="sprite__bubble" aria-hidden="true">
          ?
        </span>
      )}
    </span>
  );
}
