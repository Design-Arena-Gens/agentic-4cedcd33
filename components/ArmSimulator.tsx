'use client';

import { useEffect, useRef, useState } from 'react';

type BoxColor = 'red' | 'green' | 'blue';

type Box = {
  id: number;
  color: BoxColor;
  x: number;
  y: number;
  width: number;
  height: number;
  picked: boolean;
  delivered: boolean;
};

type Props = {
  running: boolean;
  speed: number; // 1 = normal
};

// Visual theme
const COLORS = {
  bg: '#0b1020',
  grid: 'rgba(255,255,255,0.04)',
  floor: '#0f1731',
  armBase: '#9bbcff',
  armLink: '#6aa3ff',
  armJoint: '#c6d9ff',
  gripper: '#e2ecff',
  sourceArea: '#1a244b',
  outline: 'rgba(255,255,255,0.18)',
  text: '#eef2ff',
  bins: {
    red: '#ff5c5c',
    green: '#4cd964',
    blue: '#5ac8fa',
  } as Record<BoxColor, string>,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function length(x: number, y: number) {
  return Math.hypot(x, y);
}

function stepTowards(current: number, target: number, maxDelta: number) {
  const delta = clamp(target - current, -maxDelta, maxDelta);
  return current + delta;
}

function twoLinkIK(
  targetX: number,
  targetY: number,
  baseX: number,
  baseY: number,
  link1: number,
  link2: number
) {
  // Convert target to base frame
  const dx = targetX - baseX;
  const dy = targetY - baseY;

  const dist = Math.hypot(dx, dy);
  const maxReach = link1 + link2 - 0.0001;
  const clampedDist = Math.min(dist, maxReach);
  const ux = (dx / (dist || 1)) * clampedDist;
  const uy = (dy / (dist || 1)) * clampedDist;

  const d2 = ux * ux + uy * uy;
  const cosElbow = clamp((d2 - link1 * link1 - link2 * link2) / (2 * link1 * link2), -1, 1);
  const elbow = Math.atan2(Math.sqrt(Math.max(0, 1 - cosElbow * cosElbow)), cosElbow); // elbow-down
  const shoulder = Math.atan2(uy, ux) - Math.atan2(link2 * Math.sin(elbow), link1 + link2 * Math.cos(elbow));

  const effX = baseX + link1 * Math.cos(shoulder) + link2 * Math.cos(shoulder + elbow);
  const effY = baseY + link1 * Math.sin(shoulder) + link2 * Math.sin(shoulder + elbow);

  return { shoulder, elbow, effX, effY };
}

export default function ArmSimulator({ running, speed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });

  // World config
  const worldWidth = 1100;
  const worldHeight = 620;

  // Arm config
  const baseX = 220;
  const baseY = worldHeight - 80;
  const link1 = 170;
  const link2 = 140;
  const gripperLen = 24;

  // Bins on the right side
  const binWidth = 160;
  const binHeight = 120;
  const binPadding = 20;
  const bins = {
    red: {
      x: worldWidth - binWidth - 28,
      y: worldHeight - (binHeight + binPadding) * 3 + 10,
      w: binWidth,
      h: binHeight,
      label: 'Red bin',
    },
    green: {
      x: worldWidth - binWidth - 28,
      y: worldHeight - (binHeight + binPadding) * 2 + 10,
      w: binWidth,
      h: binHeight,
      label: 'Green bin',
    },
    blue: {
      x: worldWidth - binWidth - 28,
      y: worldHeight - (binHeight + binPadding) * 1 + 10,
      w: binWidth,
      h: binHeight,
      label: 'Blue bin',
    },
  } as const;

  const sourceArea = {
    x: 40,
    y: worldHeight - 260,
    w: 260,
    h: 220,
  };

  const boxesRef = useRef<Box[]>([]);
  const [completed, setCompleted] = useState(0);

  // Arm state machine
  type Phase =
    | 'idle'
    | 'move_to_prepick'
    | 'descend_to_pick'
    | 'close_gripper'
    | 'ascend_with_box'
    | 'move_to_predrop'
    | 'descend_to_drop'
    | 'open_gripper'
    | 'complete_task';

  const phaseRef = useRef<Phase>('idle');
  const timeRef = useRef(0);
  const holdingRef = useRef<Box | null>(null);
  const targetRef = useRef<{ x: number; y: number } | null>(null);
  const preRef = useRef<{ x: number; y: number } | null>(null);
  const jointRef = useRef({ shoulder: -0.6, elbow: 1.2 });

  const pickNextBox = () => {
    const next = boxesRef.current.find((b) => !b.picked && !b.delivered);
    if (!next) return null;
    next.picked = true; // reserve
    return next;
  };

  const getBinCenter = (color: BoxColor) => {
    const b = bins[color];
    return { x: b.x + b.w / 2, y: b.y + 20 }; // drop near top
  };

  const resetBoxes = () => {
    const colors: BoxColor[] = ['red', 'green', 'blue'];
    const out: Box[] = [];
    let id = 1;
    const cols = 5;
    const rows = 5;
    const bw = 30;
    const bh = 22;
    const gap = 6;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const color = colors[(r * cols + c) % colors.length];
        const jitterX = (Math.random() - 0.5) * 6;
        const jitterY = (Math.random() - 0.5) * 6;
        out.push({
          id: id++,
          color,
          x: sourceArea.x + 18 + c * (bw + gap) + jitterX,
          y: sourceArea.y + 18 + r * (bh + gap) + jitterY,
          width: bw,
          height: bh,
          picked: false,
          delivered: false,
        });
      }
    }
    boxesRef.current = out;
    setCompleted(0);
  };

  useEffect(() => {
    resetBoxes();
    const onReset = () => {
      holdingRef.current = null;
      phaseRef.current = 'idle';
      targetRef.current = null;
      preRef.current = null;
      jointRef.current = { shoulder: -0.6, elbow: 1.2 };
      resetBoxes();
    };
    window.addEventListener('sim-reset', onReset as EventListener);
    return () => window.removeEventListener('sim-reset', onReset as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Panning and zooming
  useEffect(() => {
    const canvas = canvasRef.current!;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: MouseEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };
    const onUp = () => (dragging = false);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scaleDelta = Math.exp(-e.deltaY * 0.001);
      setViewport((v) => ({ ...v, scale: clamp(v.scale * scaleDelta, 0.6, 2.5) }));
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Main animation loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    let raf = 0;
    let lastTs = performance.now();

    const render = (ts: number) => {
      const dt = clamp((ts - lastTs) / 1000, 0, 0.05) * speed; // scaled by speed
      lastTs = ts;

      if (running) update(dt);
      draw(ctx);
      raf = requestAnimationFrame(render);
    };

    const update = (dt: number) => {
      timeRef.current += dt;
      const { shoulder, elbow } = jointRef.current;

      const currentBox = holdingRef.current ?? boxesRef.current.find((b) => b.picked && !b.delivered) ?? null;

      if (phaseRef.current === 'idle') {
        const next = pickNextBox();
        if (!next) return; // done
        // Set approach and pick targets
        const pickPoint = { x: next.x + next.width / 2, y: next.y + next.height / 2 + 6 };
        const prePick = { x: pickPoint.x, y: pickPoint.y - 90 };
        targetRef.current = pickPoint;
        preRef.current = prePick;
        phaseRef.current = 'move_to_prepick';
      }

      const speedAngle = 2.2; // rad/s base speed

      const moveJointTowards = (tx: number, ty: number) => {
        const { shoulder: sT, elbow: eT } = twoLinkIK(tx, ty, baseX, baseY, link1, link2);
        jointRef.current = {
          shoulder: stepTowards(shoulder, sT, speedAngle * dt),
          elbow: stepTowards(elbow, eT, speedAngle * dt),
        };
        const ee = twoLinkIK(baseX + 1, baseY + 1, baseX, baseY, 1, link1 + link2); // dummy to reuse math? we'll compute direct below
        return ee; // not used
      };

      const eff = ((): { x: number; y: number } => {
        const x = baseX + link1 * Math.cos(shoulder) + link2 * Math.cos(shoulder + elbow);
        const y = baseY + link1 * Math.sin(shoulder) + link2 * Math.sin(shoulder + elbow);
        return { x, y };
      })();

      if (phaseRef.current === 'move_to_prepick' && preRef.current) {
        const { x, y } = preRef.current;
        moveJointTowards(x, y);
        if (length(eff.x - x, eff.y - y) < 6) {
          phaseRef.current = 'descend_to_pick';
        }
      } else if (phaseRef.current === 'descend_to_pick' && targetRef.current) {
        const { x, y } = targetRef.current;
        moveJointTowards(x, y);
        if (length(eff.x - x, eff.y - y) < 6) {
          phaseRef.current = 'close_gripper';
          timeRef.current = 0;
        }
      } else if (phaseRef.current === 'close_gripper') {
        if (timeRef.current > 0.15) {
          // acquire
          const reserved = boxesRef.current.find((b) => b.picked && !b.delivered);
          if (reserved) {
            holdingRef.current = reserved;
          }
          phaseRef.current = 'ascend_with_box';
        }
      } else if (phaseRef.current === 'ascend_with_box' && preRef.current) {
        const { x, y } = preRef.current;
        moveJointTowards(x, y);
        if (length(eff.x - x, eff.y - y) < 6) {
          const box = holdingRef.current!;
          const dropCenter = getBinCenter(box.color);
          const preDrop = { x: dropCenter.x, y: dropCenter.y - 80 };
          preRef.current = preDrop;
          targetRef.current = dropCenter;
          phaseRef.current = 'move_to_predrop';
        }
      } else if (phaseRef.current === 'move_to_predrop' && preRef.current) {
        const { x, y } = preRef.current;
        moveJointTowards(x, y);
        if (length(eff.x - x, eff.y - y) < 6) {
          phaseRef.current = 'descend_to_drop';
        }
      } else if (phaseRef.current === 'descend_to_drop' && targetRef.current) {
        const { x, y } = targetRef.current;
        moveJointTowards(x, y);
        if (length(eff.x - x, eff.y - y) < 6) {
          phaseRef.current = 'open_gripper';
          timeRef.current = 0;
        }
      } else if (phaseRef.current === 'open_gripper') {
        if (timeRef.current > 0.15) {
          const box = holdingRef.current;
          if (box) {
            box.delivered = true;
            // Drop position stacks within bin area
            const b = bins[box.color];
            box.x = b.x + 12 + Math.random() * (b.w - 40);
            box.y = b.y + b.h - 26 - Math.random() * 40;
            setCompleted((c) => c + 1);
          }
          holdingRef.current = null;
          phaseRef.current = 'complete_task';
        }
      } else if (phaseRef.current === 'complete_task') {
        // Move to a relaxed pose before next pick
        const rest = { x: baseX + 100, y: baseY - 100 };
        moveJointTowards(rest.x, rest.y);
        if (length(eff.x - rest.x, eff.y - rest.y) < 8) {
          phaseRef.current = 'idle';
        }
      }

      // If holding a box, glue it to gripper effective position
      const held = holdingRef.current;
      if (held) {
        held.x = eff.x - held.width / 2;
        held.y = eff.y - held.height / 2;
      }
    };

    const draw = (ctx: CanvasRenderingContext2D) => {
      const dpi = window.devicePixelRatio || 1;
      const cssW = worldWidth;
      const cssH = worldHeight;
      if (canvas.width !== Math.floor(cssW * dpi) || canvas.height !== Math.floor(cssH * dpi)) {
        canvas.width = Math.floor(cssW * dpi);
        canvas.height = Math.floor(cssH * dpi);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.scale(dpi, dpi);
      }

      // Clear
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, cssW, cssH);

      // Apply viewport transform
      ctx.save();
      ctx.translate(viewport.x, viewport.y);
      ctx.scale(viewport.scale, viewport.scale);

      // Floor
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(0, cssH - 90, cssW, 120);

      // Grid
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      for (let x = 0; x < cssW; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
      }
      for (let y = 0; y < cssH; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
      }

      // Source area
      ctx.fillStyle = COLORS.sourceArea;
      ctx.strokeStyle = COLORS.outline;
      ctx.lineWidth = 2;
      roundRect(ctx, sourceArea.x, sourceArea.y, sourceArea.w, sourceArea.h, 12, true, true);
      drawLabel(ctx, sourceArea.x + 10, sourceArea.y - 10, 'Source');

      // Bins
      (['red', 'green', 'blue'] as BoxColor[]).forEach((c) => {
        const b = (bins as any)[c] as { x: number; y: number; w: number; h: number; label: string };
        ctx.strokeStyle = COLORS.outline;
        ctx.lineWidth = 2;
        roundRect(ctx, b.x, b.y, b.w, b.h, 12, false, true);

        // Color band
        ctx.fillStyle = COLORS.bins[c];
        ctx.globalAlpha = 0.18;
        roundRect(ctx, b.x + 8, b.y + 8, b.w - 16, 26, 8, true, false);
        ctx.globalAlpha = 1;

        drawLabel(ctx, b.x + 12, b.y - 10, b.label);
      });

      // Boxes
      for (const box of boxesRef.current) {
        ctx.save();
        ctx.translate(box.x, box.y);
        ctx.fillStyle = COLORS.bins[box.color];
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 2;
        roundRect(ctx, 0, 0, box.width, box.height, 5, true, true);
        ctx.restore();
      }

      // Arm
      const s = jointRef.current.shoulder;
      const e = jointRef.current.elbow;
      drawArm(ctx, baseX, baseY, s, e);

      // Legend and counters
      ctx.restore();

      ctx.fillStyle = COLORS.text;
      ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.textBaseline = 'top';
      ctx.fillText(`Completed: ${completed}/${boxesRef.current.length}`, 12, 12);
      ctx.fillText(`Phase: ${phaseRef.current}`, 12, 28);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, viewport]);

  const drawArm = (
    ctx: CanvasRenderingContext2D,
    bx: number,
    by: number,
    shoulder: number,
    elbow: number
  ) => {
    // Base
    ctx.save();
    ctx.fillStyle = COLORS.armBase;
    ctx.strokeStyle = COLORS.outline;
    ctx.lineWidth = 2;
    roundRect(ctx, bx - 28, by - 12, 56, 24, 8, true, true);

    // Shoulder joint
    ctx.beginPath();
    ctx.arc(bx, by, 10, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.armJoint;
    ctx.fill();
    ctx.stroke();

    // First link
    const x1 = bx + link1 * Math.cos(shoulder);
    const y1 = by + link1 * Math.sin(shoulder);
    drawLink(ctx, bx, by, x1, y1);

    // Elbow joint
    ctx.beginPath();
    ctx.arc(x1, y1, 8, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.armJoint;
    ctx.fill();
    ctx.stroke();

    // Second link
    const x2 = x1 + link2 * Math.cos(shoulder + elbow);
    const y2 = y1 + link2 * Math.sin(shoulder + elbow);
    drawLink(ctx, x1, y1, x2, y2);

    // Gripper
    const gripAngle = shoulder + elbow;
    const gx = x2;
    const gy = y2;
    drawGripper(ctx, gx, gy, gripAngle);

    ctx.restore();
  };

  const drawLink = (
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => {
    ctx.save();
    ctx.strokeStyle = COLORS.armLink;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  };

  const drawGripper = (ctx: CanvasRenderingContext2D, x: number, y: number, angle: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.strokeStyle = COLORS.gripper;
    ctx.lineWidth = 4;

    // jaws
    const open = phaseRef.current === 'close_gripper' ? 6 : phaseRef.current === 'open_gripper' ? 14 : 10;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(gripperLen, -open);
    ctx.moveTo(0, 0);
    ctx.lineTo(gripperLen, open);
    ctx.stroke();

    ctx.restore();
  };

  return (
    <canvas
      ref={canvasRef}
      width={worldWidth}
      height={worldHeight}
      style={{ display: 'block', width: worldWidth, height: worldHeight }}
    />
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: boolean,
  stroke: boolean
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.font = 'bold 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = '#e6edff';
  ctx.fillText(text, x, y);
  ctx.restore();
}
