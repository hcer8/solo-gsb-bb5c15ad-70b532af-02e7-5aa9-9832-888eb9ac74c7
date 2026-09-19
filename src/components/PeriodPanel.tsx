import type { PeriodCandidate, PeriodDetectFailure } from '../audio/periodDetect';

/** 周期分析失败原因的用户可读说明（保留原选区，不强制吸附） */
export const PERIOD_REASON_TEXT: Record<PeriodDetectFailure, string> = {
  'audio-too-short': '音频太短，或选区长度 1/2～2 倍的滞后范围超出可用音频，无法估计周期。',
  silence: '音频接近静音或能量变化过于平稳，无法提取有效的能量变化包络。',
  'no-peak': '未检测到显著周期峰（归一化自相关峰值过低），音频可能没有稳定周期。',
};

export interface PeriodLock {
  /** 锁定的周期（采样点） */
  periodSamples: number;
  /** 锁定候选的置信度 0..1 */
  confidence: number;
  /** 锁定候选的编号（从 1 开始） */
  rank: number;
}

interface PeriodPanelProps {
  /** 周期候选（按置信度降序，最多 3 个） */
  candidates: PeriodCandidate[];
  /** 分析失败原因（无候选时） */
  reason: PeriodDetectFailure | null;
  /** 实际搜索的滞后范围（采样点） */
  lagRange: { min: number; max: number } | null;
  /** 当前周期锁定（已吸附）状态 */
  lock: PeriodLock | null;
  sampleRate: number;
  /** 是否有可用选区（无选区时禁用分析按钮） */
  hasSelection: boolean;
  onAnalyze: () => void;
  onPick: (idx: number) => void;
  onClearLock: () => void;
}

/** 周期（秒）→ 描述文本：ms，处于常见音乐节拍范围时附带 BPM */
function fmtPeriod(periodSec: number): string {
  const ms = (periodSec * 1000).toFixed(1);
  const bpm = 60 / periodSec;
  return bpm >= 30 && bpm <= 400 ? `${ms} ms（≈${bpm.toFixed(1)} BPM）` : `${ms} ms`;
}

/**
 * 周期校准面板：对整段音频做单声道能量变化包络的归一化自相关分析，
 * 展示前 3 个周期候选及置信度；点选候选后把选区终点吸附到该周期，
 * 并把接缝搜索切换为定长约束（起止点等量平移）。
 */
export function PeriodPanel({
  candidates,
  reason,
  lagRange,
  lock,
  sampleRate,
  hasSelection,
  onAnalyze,
  onPick,
  onClearLock,
}: PeriodPanelProps) {
  return (
    <section className="panel period">
      <div className="period-head">
        <h2>周期校准</h2>
        <button className="primary" onClick={onAnalyze} disabled={!hasSelection}>
          分析周期
        </button>
        {lock && (
          <button onClick={onClearLock}>解除锁定</button>
        )}
      </div>
      <p className="period-desc">
        将整段音频混合为单声道并提取短时能量变化包络，在选区长度 1/2～2 倍的滞后范围内做归一化自相关
        （已抑制整数倍 / 分频重复峰）。点击候选可将选区终点吸附到该周期，并把接缝搜索切换为定长约束：
        起止点等量平移、周期样本数保持不变。手动调整选区会清除周期候选与锁定。
      </p>

      {lock && (
        <p className="lock-note">
          已锁定周期候选 #{lock.rank}：{fmtPeriod(lock.periodSamples / sampleRate)}，置信度{' '}
          {(lock.confidence * 100).toFixed(0)}%。接缝搜索处于定长约束模式（周期 {lock.periodSamples.toLocaleString()}{' '}
          采样点不变），可点击「解除锁定」恢复自由搜索。
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <table className="period-table">
            <thead>
              <tr>
                <th>#</th>
                <th>周期</th>
                <th>置信度</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => {
                const active = lock !== null && lock.rank === i + 1;
                return (
                  <tr key={i} className={active ? 'selected' : ''} onClick={() => onPick(i)}>
                    <td><span className="rank">{i + 1}</span></td>
                    <td>{fmtPeriod(c.periodSamples / sampleRate)}</td>
                    <td>
                      <span className="conf">
                        <span className="conf-bar">
                          <span style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                        </span>
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="row-state">{active ? '✓ 已吸附并锁定' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lagRange && (
            <p className="period-meta">
              滞后范围 {(lagRange.min / sampleRate * 1000).toFixed(0)}～
              {(lagRange.max / sampleRate * 1000).toFixed(0)} ms · 自相关峰值：
              {candidates.map((c) => c.peak.toFixed(2)).join(' / ')}
            </p>
          )}
        </>
      )}

      {candidates.length === 0 && reason && (
        <p className="clamp-note">周期分析不可用：{PERIOD_REASON_TEXT[reason]}已保留原选区，未做吸附。</p>
      )}
    </section>
  );
}
