import type { AudioDataLike } from './types';
import { fftInPlace, nextPow2 } from './fft';

/**
 * 周期校准：把整段音频混合为单声道，提取短时能量变化包络
 * （相邻帧能量差，即新颖度包络），在「选区长度 1/2～2 倍」的滞后范围内
 * 做归一化自相关，找出最显著的若干周期候选。
 *
 * - 滞后范围受可用音频长度约束：自相关至少保留 max(包络一半, 8 帧) 的重叠，
 *   超出可用范围的滞后直接裁掉；范围为空时判定 audio-too-short。
 * - 静音 / 能量过于平稳（包络方差接近 0）时判定 silence，不产生候选。
 * - 峰值显著性：归一化自相关峰值 ≥ minPeak 且局部突出度 ≥ minProminence，
 *   否则判定 no-peak。
 * - 整数倍 / 分频抑制：按峰值强度降序贪心接受候选，与已接受候选呈
 *   2/3/4 倍（或 1/2、1/3、1/4）关系的峰视为同一基频的重复峰被跳过。
 * - 周期精度：对峰值位置做抛物线插值细化到亚帧，再换算为采样点。
 * - 置信度：峰值与局部突出度加权，再乘以包络相对起伏系数——
 *   能量几乎不变的信号（如恒定音调的加窗拍频伪周期）置信度被压得很低。
 */

export interface PeriodCandidate {
  /** 周期（采样点，亚帧插值后取整） */
  periodSamples: number;
  /** 归一化自相关峰值（0..1） */
  peak: number;
  /** 置信度 0..1（峰值与局部突出度的加权） */
  confidence: number;
}

/** 无法给出周期候选的原因 */
export type PeriodDetectFailure = 'audio-too-short' | 'silence' | 'no-peak';

export interface PeriodDetectResult {
  /** 周期候选（按置信度降序，最多 maxCandidates 个） */
  candidates: PeriodCandidate[];
  /** 无候选时的失败原因；有候选时为 null */
  reason: PeriodDetectFailure | null;
  /** 实际搜索的滞后范围（采样点），供界面展示；分析不可用时为 null */
  lagRangeSamples: { min: number; max: number } | null;
  /** 包络帧移（采样点） */
  hopSamples: number;
}

export interface PeriodDetectOptions {
  /** 包络帧移（采样点），默认约 5 ms（按采样率换算，最小 32） */
  hopSamples?: number;
  /** 显著峰所需的最低归一化自相关值，默认 0.25 */
  minPeak?: number;
  /** 显著峰所需的最低局部突出度，默认 0.03 */
  minProminence?: number;
  /** 最大候选数量，默认 3 */
  maxCandidates?: number;
}

/** 包络帧最少数量，低于此值判定音频太短 */
const MIN_FRAMES = 12;
/** 自相关最少重叠帧数 */
const MIN_OVERLAP = 8;
/** 静音判定：包络 RMS 峰值低于 −80 dBFS */
const SILENCE_RMS = 1e-4;
/** 平稳判定：能量变化包络的相对起伏（stdD / 峰值 RMS）低于 0.1% 视为无有效起伏 */
const FLAT_REL = 1e-3;
/** 置信度参考起伏：相对起伏达到 5% 时不再降低置信度 */
const FULL_CONF_REL = 0.05;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function detectPeriods(
  audio: AudioDataLike,
  selectionSamples: number,
  options: PeriodDetectOptions = {},
): PeriodDetectResult {
  const sr = audio.sampleRate;
  const hop = Math.max(32, Math.round(options.hopSamples ?? sr * 0.005));
  const minPeak = options.minPeak ?? 0.25;
  const minProm = options.minProminence ?? 0.03;
  const maxCandidates = Math.max(1, Math.round(options.maxCandidates ?? 3));
  const fail = (reason: PeriodDetectFailure): PeriodDetectResult => ({
    candidates: [],
    reason,
    lagRangeSamples: null,
    hopSamples: hop,
  });

  const len = audio.length;
  const nCh = audio.numberOfChannels;
  if (nCh === 0 || !Number.isFinite(selectionSamples) || selectionSamples <= 0) {
    return fail('audio-too-short');
  }

  // ---- 混合为单声道 ----
  const mono = new Float32Array(len);
  for (let c = 0; c < nCh; c++) {
    const x = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += x[i];
  }
  const invCh = 1 / nCh;
  for (let i = 0; i < len; i++) mono[i] *= invCh;

  // ---- 短时能量包络：帧长 2·hop、帧移 hop 的 RMS ----
  const win = 2 * hop;
  const frameCount = Math.floor((len - win) / hop) + 1;
  if (frameCount < MIN_FRAMES) return fail('audio-too-short');
  const energy = new Float32Array(frameCount);
  let maxE = 0;
  for (let f = 0; f < frameCount; f++) {
    const off = f * hop;
    let acc = 0;
    for (let i = 0; i < win; i++) {
      const v = mono[off + i];
      acc += v * v;
    }
    const rms = Math.sqrt(acc / win);
    energy[f] = rms;
    if (rms > maxE) maxE = rms;
  }
  if (maxE < SILENCE_RMS) return fail('silence');

  // ---- 能量变化包络：相邻帧能量差，去均值 ----
  const N = frameCount - 1;
  const d = new Float32Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) {
    d[i] = energy[i + 1] - energy[i];
    mean += d[i];
  }
  mean /= N;
  let varD = 0;
  for (let i = 0; i < N; i++) {
    d[i] -= mean;
    varD += d[i] * d[i];
  }
  // 能量过于平稳（如纯静音底噪、直流或恒定电平）：包络无有效起伏
  const stdRel = Math.sqrt(varD / N) / maxE;
  if (stdRel < FLAT_REL) return fail('silence');

  // ---- 滞后范围：选区长度 1/2～2 倍，受可用音频约束 ----
  const minLag = Math.max(2, Math.floor((0.5 * selectionSamples) / hop));
  const maxLag = Math.min(
    Math.ceil((2 * selectionSamples) / hop),
    Math.floor(N / 2),
    N - MIN_OVERLAP,
  );
  if (maxLag < minLag) return fail('audio-too-short');

  // ---- 归一化自相关：FFT 求分子，前缀和求分母 ----
  const nfft = nextPow2(2 * N);
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  re.set(d);
  fftInPlace(re, im);
  for (let k = 0; k < nfft; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  // 功率谱为实偶序列，再次正变换取实部即得线性自相关（需除以 nfft）
  fftInPlace(re, im);
  const acf = re;

  // d² 的前缀和：E0 = Σd[0..N−τ)²，E1 = Σd[τ..N)²
  const sq = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) sq[i + 1] = sq[i] + d[i] * d[i];

  const r = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const den = Math.sqrt(sq[N - lag] * (sq[N] - sq[lag]));
    r[lag] = den > 0 ? (acf[lag] / nfft / den) : 0;
  }

  // ---- 峰值拾取：局部极大值 + 显著性阈值 + 局部突出度 ----
  interface Peak {
    lag: number;
    value: number;
    prominence: number;
  }
  const peaks: Peak[] = [];
  for (let lag = minLag + 1; lag <= maxLag - 1; lag++) {
    const v = r[lag];
    if (v < minPeak) continue;
    if (v < r[lag - 1] || v <= r[lag + 1]) continue;
    // 突出度：峰与两侧 ±8% 滞后窗口内最深谷值的差
    const w = Math.max(2, Math.round(0.08 * lag));
    let leftMin = v;
    let rightMin = v;
    for (let k = Math.max(minLag, lag - w); k < lag; k++) if (r[k] < leftMin) leftMin = r[k];
    for (let k = lag + 1; k <= Math.min(maxLag, lag + w); k++) if (r[k] < rightMin) rightMin = r[k];
    const prominence = v - Math.max(leftMin, rightMin);
    if (prominence < minProm) continue;
    peaks.push({ lag, value: v, prominence });
  }
  if (peaks.length === 0) return fail('no-peak');

  // ---- 整数倍 / 分频抑制：按峰值降序贪心接受，跳过与已接受峰呈整数比关系的峰 ----
  peaks.sort((a, b) => b.value - a.value);
  const accepted: Peak[] = [];
  for (const p of peaks) {
    let related = false;
    for (const q of accepted) {
      for (const k of [2, 3, 4]) {
        const up = q.lag * k; // p 是 q 的 k 倍（谐波）
        const down = q.lag / k; // p 是 q 的 1/k（分频）
        if (
          Math.abs(p.lag - up) <= Math.max(1.5, 0.03 * up) ||
          Math.abs(p.lag - down) <= Math.max(1.5, 0.03 * down)
        ) {
          related = true;
          break;
        }
      }
      if (related) break;
    }
    if (related) continue;
    accepted.push(p);
    if (accepted.length >= maxCandidates) break;
  }
  if (accepted.length === 0) return fail('no-peak');

  // ---- 抛物线插值细化 + 置信度 ----
  // 置信度 = 峰值/突出度加权 × 包络起伏系数：能量几乎不变的信号
  // （如恒定音调的加窗拍频伪周期）即使自相关很高也不可信
  const fluctScale = clamp01(stdRel / FULL_CONF_REL);
  const candidates: PeriodCandidate[] = accepted.map((p) => {
    const y0 = r[p.lag - 1];
    const y1 = r[p.lag];
    const y2 = r[p.lag + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = Math.abs(denom) > 1e-12 ? Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom)) : 0;
    const base = 0.65 * clamp01((p.value - 0.2) / 0.6) + 0.35 * clamp01(p.prominence / 0.4);
    const confidence = clamp01(base * fluctScale);
    return {
      periodSamples: Math.max(1, Math.round((p.lag + shift) * hop)),
      peak: Math.round(p.value * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
    };
  });
  candidates.sort((a, b) => b.confidence - a.confidence);

  return {
    candidates,
    reason: null,
    lagRangeSamples: { min: minLag * hop, max: maxLag * hop },
    hopSamples: hop,
  };
}
