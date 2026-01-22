"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValue, useMotionTemplate } from "framer-motion";

/* =========================
   Utils
========================= */
function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatHMS(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function parseHHMM(value: string): { hh: number; mm: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function targetFromHHMM(now: Date, hh: number, mm: number) {
  const t = new Date(now.getTime());
  t.setHours(hh, mm, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/* =========================
   LocalStorage helpers
========================= */
const LS_KEY = "timer_v1";

type TimerMode = "horario" | "pomodoro";
type ParticleMode = "repel" | "attract";
type PomodoroPhase = "work" | "break" | "longBreak";

type PersistedState = {
  timerMode: TimerMode;
  particleMode: ParticleMode;

  timeStr: string;
  targetISO?: string;

  pomodoro: {
    enabled: boolean;
    phase: PomodoroPhase;
    cycleCount: number;
    endISO?: string;
    workMin: number;
    breakMin: number;
    longBreakMin: number;
  };

  soundEnabled: boolean;
  notificationsEnabled: boolean;
};

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

function saveState(state: PersistedState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/* =========================
   Sound (Web Audio)
========================= */
function playBeep() {
  try {
    const AudioCtx = (window.AudioContext ||
      (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.0001;

    o.connect(g);
    g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);

    o.start(t0);
    o.stop(t0 + 0.36);

    o.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // ignore
  }
}

/* =========================
   Notifications
========================= */
async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof window === "undefined") return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

function notify(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // ignore
  }
}

/* =========================
   Particle Background (Canvas)
========================= */
function ParticleBackground({ mode }: { mode: ParticleMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const mouseRef = useRef({ x: 0, y: 0, active: false });

  const config = useMemo(
    () => ({
      density: 0.00009,
      maxParticles: 170,
      linkDist: 150,
      speed: 0.42,
      drift: 0.1,
      radiusMin: 1.0,
      radiusMax: 2.9,

      influenceRadius: 190,
      force: 0.09,
      mouseBoostLinks: 0.4,
      friction: 0.985,
      maxV: 1.3,
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    let w = 0;
    let h = 0;

    type P = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      a: number;
    };
    let particles: P[] = [];

    const rand = (min: number, max: number) =>
      min + Math.random() * (max - min);

    const spawn = (): P => {
      const angle = rand(0, Math.PI * 2);
      const sp = config.speed * rand(0.55, 1.45);
      return {
        x: rand(0, w || 900),
        y: rand(0, h || 600),
        vx: Math.cos(angle) * sp + rand(-config.drift, config.drift),
        vy: Math.sin(angle) * sp + rand(-config.drift, config.drift),
        r: rand(config.radiusMin, config.radiusMax),
        a: rand(0.22, 0.65),
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));

      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const desired = Math.min(
        config.maxParticles,
        Math.max(35, Math.floor(w * h * config.density)),
      );

      if (particles.length < desired) {
        for (let i = 0; i < desired - particles.length; i++)
          particles.push(spawn());
      } else if (particles.length > desired) {
        particles = particles.slice(0, desired);
      }
    };

    const getCanvasPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = getCanvasPos(e);
      mouseRef.current.x = p.x;
      mouseRef.current.y = p.y;
      mouseRef.current.active = true;
    };

    const onPointerLeave = () => {
      mouseRef.current.active = false;
    };

    const step = () => {
      ctx.clearRect(0, 0, w, h);

      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      const mouseActive = mouseRef.current.active;

      const dir = mode === "repel" ? 1 : -1;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        if (mouseActive) {
          const dx = p.x - mx;
          const dy = p.y - my;
          const dist = Math.hypot(dx, dy);

          if (dist < config.influenceRadius && dist > 0.001) {
            const s = 1 - dist / config.influenceRadius;
            const push = config.force * (s * s) * 60;

            p.vx += dir * (dx / dist) * push;
            p.vy += dir * (dy / dist) * push;
          }
        }

        p.vx *= config.friction;
        p.vy *= config.friction;

        p.vx = clamp(p.vx, -config.maxV, config.maxV);
        p.vy = clamp(p.vy, -config.maxV, config.maxV);

        p.x += p.vx;
        p.y += p.vy;

        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${p.a})`;
        ctx.fill();
      }

      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];

        let boost = 0;
        if (mouseActive) {
          const dm = Math.hypot(a.x - mx, a.y - my);
          boost = Math.max(0, 1 - dm / (config.influenceRadius * 1.2));
        }

        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);

          if (dist < config.linkDist) {
            const baseAlpha = (1 - dist / config.linkDist) * 0.2;
            const alpha = baseAlpha + boost * config.mouseBoostLinks * 0.18;

            ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      rafRef.current = requestAnimationFrame(step);
    };

    resize();
    rafRef.current = requestAnimationFrame(step);

    window.addEventListener("resize", resize);
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    canvas.addEventListener("pointerleave", onPointerLeave);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [config, mode]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    />
  );
}

/* =========================
   Page
========================= */
export default function Page() {
  // ✅ anti-hydration mismatch
  const [mounted, setMounted] = useState(false);

  const [now, setNow] = useState<Date>(() => new Date());

  const [timerMode, setTimerMode] = useState<TimerMode>("horario");
  const [particleMode, setParticleMode] = useState<ParticleMode>("repel");

  const [timeStr, setTimeStr] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 5);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  });

  const [target, setTarget] = useState<Date>(() => {
    const d = new Date();
    const parsed = parseHHMM(
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    ) || {
      hh: d.getHours(),
      mm: d.getMinutes(),
    };
    return targetFromHHMM(d, parsed.hh, parsed.mm);
  });

  const [remaining, setRemaining] = useState(0);

  // pomodoro
  const [pomoEnabled, setPomoEnabled] = useState(false);
  const [pomoPhase, setPomoPhase] = useState<PomodoroPhase>("work");
  const [pomoCycleCount, setPomoCycleCount] = useState(0);

  const [workMin, setWorkMin] = useState(25);
  const [breakMin, setBreakMin] = useState(5);
  const [longBreakMin, setLongBreakMin] = useState(15);

  // avisos
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // glow card
  const mx = useMotionValue(-9999);
  const my = useMotionValue(-9999);
  const glow = useMotionTemplate`radial-gradient(420px circle at ${mx}px ${my}px, rgba(255,255,255,0.12), transparent 60%)`;

  const lastCompletedTargetMsRef = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // load localStorage
  useEffect(() => {
    if (!mounted) return;
    const s = loadState();
    if (!s) return;

    setTimerMode(s.timerMode);
    setParticleMode(s.particleMode);
    setTimeStr(s.timeStr);

    setSoundEnabled(s.soundEnabled);
    setNotificationsEnabled(s.notificationsEnabled);

    setPomoEnabled(s.pomodoro.enabled);
    setPomoPhase(s.pomodoro.phase);
    setPomoCycleCount(s.pomodoro.cycleCount);
    setWorkMin(s.pomodoro.workMin);
    setBreakMin(s.pomodoro.breakMin);
    setLongBreakMin(s.pomodoro.longBreakMin);

    const iso = s.timerMode === "pomodoro" ? s.pomodoro.endISO : s.targetISO;
    if (iso) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) setTarget(d);
    }
  }, [mounted]);

  // save localStorage
  useEffect(() => {
    if (!mounted) return;
    const state: PersistedState = {
      timerMode,
      particleMode,
      timeStr,
      targetISO: timerMode === "horario" ? target.toISOString() : undefined,
      pomodoro: {
        enabled: pomoEnabled,
        phase: pomoPhase,
        cycleCount: pomoCycleCount,
        endISO: timerMode === "pomodoro" ? target.toISOString() : undefined,
        workMin,
        breakMin,
        longBreakMin,
      },
      soundEnabled,
      notificationsEnabled,
    };
    saveState(state);
  }, [
    mounted,
    timerMode,
    particleMode,
    timeStr,
    target,
    pomoEnabled,
    pomoPhase,
    pomoCycleCount,
    workMin,
    breakMin,
    longBreakMin,
    soundEnabled,
    notificationsEnabled,
  ]);

  // tick
  useEffect(() => {
    if (!mounted) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [mounted]);

  // remaining
  useEffect(() => {
    if (!mounted) return;
    const diffMs = target.getTime() - now.getTime();
    setRemaining(Math.max(0, Math.floor(diffMs / 1000)));
  }, [mounted, now, target]);

  const finished = mounted ? remaining <= 0 : false;

  // on finish
  useEffect(() => {
    if (!mounted) return;
    if (!finished) return;

    const tgt = target.getTime();
    if (lastCompletedTargetMsRef.current === tgt) return;
    lastCompletedTargetMsRef.current = tgt;

    if (soundEnabled) playBeep();

    if (
      notificationsEnabled &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      const title =
        timerMode === "pomodoro" ? "Pomodoro finalizado" : "Timer finalizado";
      const body =
        timerMode === "pomodoro"
          ? `Fase: ${pomoPhase === "work" ? "Trabalho" : pomoPhase === "break" ? "Pausa" : "Pausa longa"}`
          : `Alvo: ${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
      notify(title, body);
    }

    if (timerMode === "pomodoro" && pomoEnabled) {
      const n = new Date();

      if (pomoPhase === "work") {
        const nextCount = pomoCycleCount + 1;

        if (nextCount >= 4) {
          setPomoPhase("longBreak");
          setPomoCycleCount(0);
          setTarget(new Date(n.getTime() + longBreakMin * 60 * 1000));
        } else {
          setPomoPhase("break");
          setPomoCycleCount(nextCount);
          setTarget(new Date(n.getTime() + breakMin * 60 * 1000));
        }
      } else {
        setPomoPhase("work");
        setTarget(new Date(n.getTime() + workMin * 60 * 1000));
      }
    }
  }, [
    mounted,
    finished,
    target,
    soundEnabled,
    notificationsEnabled,
    timerMode,
    pomoEnabled,
    pomoPhase,
    pomoCycleCount,
    workMin,
    breakMin,
    longBreakMin,
  ]);

  function applyTargetFromInput() {
    const parsed = parseHHMM(timeStr);
    if (!parsed) return;
    const n = new Date();
    setNow(n);
    setTarget(targetFromHHMM(n, parsed.hh, parsed.mm));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") applyTargetFromInput();
  }

  function startPomodoroNow(phase: PomodoroPhase) {
    const n = new Date();
    setNow(n);
    setTimerMode("pomodoro");
    setPomoEnabled(true);
    setPomoPhase(phase);

    const mins =
      phase === "work" ? workMin : phase === "break" ? breakMin : longBreakMin;
    setTarget(new Date(n.getTime() + mins * 60 * 1000));
  }

  async function enableNotifications() {
    const perm = await requestNotificationPermission();
    if (perm === "granted") {
      setNotificationsEnabled(true);
      notify(
        "Notificações ativadas ✅",
        "Você vai receber aviso quando finalizar.",
      );
    } else {
      setNotificationsEnabled(false);
    }
  }

  const targetLabel = `${pad2(target.getHours())}:${pad2(target.getMinutes())}:${pad2(
    target.getSeconds(),
  )}`;

  const phaseLabel =
    pomoPhase === "work"
      ? "Trabalho"
      : pomoPhase === "break"
        ? "Pausa"
        : "Pausa longa";

  if (!mounted) {
    return <div className="min-h-screen bg-slate-950" />;
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0">
        <div className="absolute inset-0 opacity-70 bg-[radial-gradient(circle_at_25%_25%,rgba(99,102,241,0.35),transparent_45%),radial-gradient(circle_at_75%_25%,rgba(236,72,153,0.22),transparent_50%),radial-gradient(circle_at_55%_80%,rgba(34,211,238,0.18),transparent_55%)]" />
        <ParticleBackground mode={particleMode} />
        <div className="absolute inset-0 bg-slate-950/45" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6">
        <motion.div
          className="w-full rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl relative overflow-hidden"
          onMouseMove={(e) => {
            const rect = (
              e.currentTarget as HTMLDivElement
            ).getBoundingClientRect();
            mx.set(e.clientX - rect.left);
            my.set(e.clientY - rect.top);
          }}
          onMouseLeave={() => {
            mx.set(-9999);
            my.set(-9999);
          }}
        >
          <motion.div
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: glow }}
          />

          <div className="relative">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm text-white/70">Hora do PC</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {pad2(now.getHours())}:{pad2(now.getMinutes())}:
                  {pad2(now.getSeconds())}
                </p>
              </div>

              <div className="md:text-right">
                <p className="text-sm text-white/70">
                  {timerMode === "pomodoro" ? "Pomodoro" : "Alvo"}
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {timerMode === "pomodoro" ? phaseLabel : targetLabel}
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-white/70">Modo</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => setTimerMode("horario")}
                    className={`rounded-xl px-4 py-2 text-sm transition ${
                      timerMode === "horario"
                        ? "bg-white/15"
                        : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    Horário (HH:MM)
                  </button>
                  <button
                    onClick={() => setTimerMode("pomodoro")}
                    className={`rounded-xl px-4 py-2 text-sm transition ${
                      timerMode === "pomodoro"
                        ? "bg-white/15"
                        : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    Pomodoro
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() =>
                      setParticleMode((m) =>
                        m === "repel" ? "attract" : "repel",
                      )
                    }
                    className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                  >
                    Partículas:{" "}
                    {particleMode === "repel" ? "Repelir" : "Atrair"}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-white/70">Avisos</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => setSoundEnabled((v) => !v)}
                    className={`rounded-xl px-4 py-2 text-sm transition ${
                      soundEnabled
                        ? "bg-white/15"
                        : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    Som: {soundEnabled ? "Ligado" : "Desligado"}
                  </button>

                  <button
                    onClick={enableNotifications}
                    className={`rounded-xl px-4 py-2 text-sm transition ${
                      notificationsEnabled
                        ? "bg-white/15"
                        : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    Notificações: {notificationsEnabled ? "Ligadas" : "Ativar"}
                  </button>

                  <button
                    onClick={() => playBeep()}
                    className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                  >
                    Testar som
                  </button>
                </div>

                <p className="mt-3 text-xs text-white/50">
                  *Notificações dependem da permissão do navegador.
                </p>
              </div>
            </div>

            {timerMode === "horario" ? (
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
                <label className="block text-sm text-white/70">
                  Defina o horário (HH:MM)
                </label>
                <div className="mt-2 grid gap-3 md:grid-cols-[1fr_auto]">
                  <input
                    value={timeStr}
                    onChange={(e) => setTimeStr(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="18:30"
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base outline-none focus:border-white/25"
                    inputMode="numeric"
                  />
                  <button
                    onClick={applyTargetFromInput}
                    className="h-[52px] rounded-xl bg-white/10 px-5 text-sm font-semibold hover:bg-white/15 transition"
                  >
                    Iniciar
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/50">
                  Se o horário já passou hoje, conta para amanhã
                  automaticamente.
                </p>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm text-white/70">Pomodoro</p>
                    <p className="text-xs text-white/50">
                      Ciclo: {pomoCycleCount}/4 (após 4 trabalhos → pausa longa)
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => startPomodoroNow("work")}
                      className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                    >
                      Iniciar Trabalho
                    </button>
                    <button
                      onClick={() => startPomodoroNow("break")}
                      className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                    >
                      Iniciar Pausa
                    </button>
                    <button
                      onClick={() => startPomodoroNow("longBreak")}
                      className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                    >
                      Pausa Longa
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div>
                    <label className="block text-xs text-white/60">
                      Trabalho (min)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={workMin}
                      onChange={(e) =>
                        setWorkMin(clamp(Number(e.target.value || 25), 1, 180))
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 outline-none focus:border-white/25"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60">
                      Pausa (min)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={breakMin}
                      onChange={(e) =>
                        setBreakMin(clamp(Number(e.target.value || 5), 1, 60))
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 outline-none focus:border-white/25"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60">
                      Pausa longa (min)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={longBreakMin}
                      onChange={(e) =>
                        setLongBreakMin(
                          clamp(Number(e.target.value || 15), 1, 120),
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 outline-none focus:border-white/25"
                    />
                  </div>
                </div>

                <p className="mt-3 text-xs text-white/50">
                  Ao zerar, ele toca/notifica e avança automaticamente para a
                  próxima fase.
                </p>
              </div>
            )}

            <div className="mt-8">
              <p className="text-sm text-white/70">Contagem regressiva</p>

              <div className="mt-2 flex items-center justify-between gap-4">
                <motion.div
                  className="text-6xl font-bold tabular-nums tracking-tight"
                  animate={finished ? { scale: [1, 1.05, 1] } : {}}
                  transition={{
                    duration: 0.6,
                    repeat: finished ? Infinity : 0,
                  }}
                >
                  {formatHMS(remaining)}
                </motion.div>

                <motion.div
                  className={`rounded-2xl px-4 py-2 text-sm font-semibold ${
                    finished
                      ? "bg-emerald-500/20 text-emerald-200"
                      : "bg-sky-500/15 text-sky-200"
                  }`}
                  animate={finished ? { opacity: [1, 0.6, 1] } : {}}
                  transition={{
                    duration: 1.1,
                    repeat: finished ? Infinity : 0,
                  }}
                >
                  {finished ? "Finalizado ✅" : "Rodando…"}
                </motion.div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={() => setTarget(new Date())}
                  className="rounded-xl bg-rose-500/20 px-4 py-2 text-sm hover:bg-rose-500/25 transition"
                >
                  Zerar
                </button>

                {timerMode === "pomodoro" && (
                  <button
                    onClick={() => {
                      setPomoCycleCount(0);
                      setPomoPhase("work");
                    }}
                    className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15 transition"
                  >
                    Reset ciclo
                  </button>
                )}
              </div>

              <p className="mt-4 text-xs text-white/50">
                *Baseado no relógio do PC. Se você mudar o horário do Windows, a
                contagem muda junto.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
