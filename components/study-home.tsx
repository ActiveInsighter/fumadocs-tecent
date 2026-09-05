'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const EXPECTED_EXAM_START = new Date('2026-12-19T08:30:00+08:00').getTime();

const encouragements = [
  '不用突然变得很厉害，今天比昨天多会一道题就够了。',
  '把不会的题留下痕迹，它们会慢慢变成你的分数。',
  '稳定不是每天状态都满格，而是状态一般也能继续。',
  '先完成，再漂亮；先把这一页学明白。',
  '真正拉开差距的，常常是那些普通但没有放弃的下午。',
  '错题不是扣分记录，是下一次拿分的地图。',
  '今天记住的一个结论，会在考场上替你省下一分钟。',
  '别和整本书较劲，只处理眼前这一小节。',
  '专注四十分钟，比焦虑四个小时更接近答案。',
  '进度可以慢，方向别乱；重复本身就是复利。',
  '有些知识第一次只是见面，第二次才认识，第三次才会用。',
  '你不需要等状态来，开始之后状态才会来。',
] as const;

const modules = [
  { name: '政治', href: '/docs/politics' },
  { name: '英语', href: '/docs/english' },
  { name: '数学', href: '/docs/math' },
  { name: '专业课', href: '/docs/408' },
] as const;

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

function getRemaining(now: number): Remaining {
  const totalSeconds = Math.max(0, Math.floor((EXPECTED_EXAM_START - now) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function StudyHome() {
  const [remaining, setRemaining] = useState<Remaining | null>(null);
  const [encouragementIndex, setEncouragementIndex] = useState(0);

  useEffect(() => {
    const tick = () => setRemaining(getRemaining(Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const dayIndex = Math.floor(Date.now() / 86_400_000);
    setEncouragementIndex(dayIndex % encouragements.length);
  }, []);

  const countdown = useMemo(
    () => ({
      days: remaining ? String(remaining.days) : '—',
      hours: remaining ? pad(remaining.hours) : '—',
      minutes: remaining ? pad(remaining.minutes) : '—',
      seconds: remaining ? pad(remaining.seconds) : '—',
    }),
    [remaining],
  );

  const nextEncouragement = () => {
    setEncouragementIndex((current) => (current + 1) % encouragements.length);
  };

  return (
    <main className="flex min-h-[calc(100dvh-4rem)] items-center px-6 py-16 sm:px-10">
      <section className="mx-auto w-full max-w-5xl">
        <p className="text-sm font-medium tracking-wide text-fd-muted-foreground">
          考研学习 · 2027
        </p>

        <h1 className="mt-5 max-w-4xl text-4xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
          把今天学明白，明天就会轻一点。
        </h1>

        <div className="mt-12 border-y py-8" aria-label="考研倒计时" aria-live="polite">
          <p className="mb-5 text-sm text-fd-muted-foreground">距离预计初试开始还有</p>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-3 sm:gap-x-8">
            <span className="text-5xl font-semibold tabular-nums sm:text-7xl">
              {countdown.days}
              <span className="ml-2 text-base font-normal text-fd-muted-foreground">天</span>
            </span>
            <span className="text-3xl font-medium tabular-nums sm:text-5xl">
              {countdown.hours}
              <span className="ml-1.5 text-sm font-normal text-fd-muted-foreground">时</span>
            </span>
            <span className="text-3xl font-medium tabular-nums sm:text-5xl">
              {countdown.minutes}
              <span className="ml-1.5 text-sm font-normal text-fd-muted-foreground">分</span>
            </span>
            <span className="text-3xl font-medium tabular-nums sm:text-5xl">
              {countdown.seconds}
              <span className="ml-1.5 text-sm font-normal text-fd-muted-foreground">秒</span>
            </span>
          </div>
          <p className="mt-5 text-xs leading-5 text-fd-muted-foreground">
            2027 年考研初试时间目前尚未正式公布，暂按 2026 年 12 月 19 日 08:30（北京时间）计算。
          </p>
        </div>

        <div className="mt-9 flex max-w-3xl items-start gap-4">
          <p className="min-h-14 flex-1 text-lg leading-8 sm:text-xl">
            “{encouragements[encouragementIndex]}”
          </p>
          <button
            type="button"
            onClick={nextEncouragement}
            className="shrink-0 border-b border-current py-1 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            换一句
          </button>
        </div>

        <nav className="mt-12 flex flex-wrap gap-x-7 gap-y-4" aria-label="学习模块">
          {modules.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className="group inline-flex items-center gap-2 text-base font-medium"
            >
              <span>{item.name}</span>
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                →
              </span>
            </Link>
          ))}
        </nav>

        <p className="mt-14 text-sm text-fd-muted-foreground">
          今天不必解决所有问题。先打开下一节。
        </p>
      </section>
    </main>
  );
}
