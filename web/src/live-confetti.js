/** Lightweight canvas confetti — no external dependency. */

const COLORS = ["#bce785", "#f0d36a", "#9ed67a", "#e8eee7", "#6fae69", "#c9a84a", "#7ec8e3"];

const rand = (min, max) => min + Math.random() * (max - min);

export const burstConfetti = (root = document.body, options = {}) => {
  if (typeof document === "undefined") return () => {};
  const duration = Number(options.durationMs) || 3200;
  const count = Number(options.count) || 140;
  const canvas = document.createElement("canvas");
  canvas.className = "live-confetti-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener("resize", resize);
  root.appendChild(canvas);

  const cx = canvas.width / 2;
  const cy = canvas.height * 0.38;
  const pieces = Array.from({ length: count }, () => {
    const angle = rand(-Math.PI, 0);
    const speed = rand(7, 18);
    return {
      x: cx + rand(-80, 80),
      y: cy + rand(-20, 20),
      vx: Math.cos(angle) * speed + rand(-3, 3),
      vy: Math.sin(angle) * speed,
      w: rand(6, 11),
      h: rand(8, 14),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.25, 0.25),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      gravity: rand(0.18, 0.32),
      drag: rand(0.985, 0.995),
      life: 1,
    };
  });

  const started = performance.now();
  let frame = 0;
  let stopped = false;

  const tick = (now) => {
    if (stopped) return;
    const elapsed = now - started;
    const t = Math.min(1, elapsed / duration);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const piece of pieces) {
      piece.vx *= piece.drag;
      piece.vy = piece.vy * piece.drag + piece.gravity;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.rot += piece.vr;
      piece.life = 1 - t;
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rot);
      ctx.globalAlpha = Math.max(0, piece.life);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      ctx.restore();
    }
    if (t < 1) {
      frame = requestAnimationFrame(tick);
    } else {
      cleanup();
    }
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };

  frame = requestAnimationFrame(tick);
  return cleanup;
};
