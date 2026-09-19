import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Waveform, type Region, type SeamMarker } from './components/Waveform';
import { SeamSpectrumPanel } from './components/SeamSpectrumPanel';
import { PeriodPanel, PERIOD_REASON_TEXT, type PeriodLock } from './components/PeriodPanel';
import { LoopPlayer } from './audio/player';
import { decodeAudioFile } from './audio/decode';
import { findCandidateSeams, type SeamResult } from './audio/loopFinder';
import { detectPeriods, type PeriodCandidate, type PeriodDetectFailure } from './audio/periodDetect';
import { buildLoopPcm } from './audio/loopBuffer';
import { analyzeSeamSpectrum } from './audio/seamSpectrum';
import { encodeWav, wavFileSize } from './audio/wavExport';
import { fmtBytes, fmtTime } from './utils/format';

const SLOPE_WINDOW = 32;
const SLOPE_WEIGHT = 1;
const MIN_LOOP_SECONDS = 0.05;
/** 候选接缝数量（按代价升序） */
const MAX_CANDIDATES = 5;

/** 保留 decimals 位小数的有限数值（防御 NaN / Infinity 进入 JSON） */
const roundTo = (x: number, decimals: number): number => {
  if (!Number.isFinite(x)) return 0;
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
};

type PlayTarget = 'original' | 'optimized';

export default function App() {
  const [fileName, setFileName] = useState('');
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [selection, setSelection] = useState<Region | null>(null);
  const [candidates, setCandidates] = useState<SeamResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [radiusMs, setRadiusMs] = useState(50);
  const [crossfadeMs, setCrossfadeMs] = useState(20);
  const [specWindowMs, setSpecWindowMs] = useState(200);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  const [status, setStatus] = useState('请导入 WAV / MP3 音频文件（音频仅在本地浏览器处理，不会上传）。');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 周期校准：候选列表、失败原因、滞后范围与锁定状态
  const [periodCandidates, setPeriodCandidates] = useState<PeriodCandidate[]>([]);
  const [periodReason, setPeriodReason] = useState<PeriodDetectFailure | null>(null);
  const [periodLagRange, setPeriodLagRange] = useState<{ min: number; max: number } | null>(null);
  const [periodLock, setPeriodLock] = useState<PeriodLock | null>(null);
  const playerRef = useRef<LoopPlayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 当前选中的候选接缝：「试听选中候选」与 JSON / WAV 导出的目标
  const seam = candidates[selectedIdx] ?? null;

  // 接缝频谱检查：当前候选的循环 PCM（与试听 / 导出口径一致，含交叉淡化），
  // 切换候选或调整交叉淡化时自动重建，频谱分析随之实时重算
  const loopPcm = useMemo(() => {
    if (!buffer || !seam) return null;
    return buildLoopPcm(buffer, seam.startSample, seam.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
  }, [buffer, seam, crossfadeMs]);

  const spectrum = useMemo(() => {
    if (!loopPcm) return null;
    return analyzeSeamSpectrum(loopPcm, (specWindowMs / 1000) * loopPcm.sampleRate);
  }, [loopPcm, specWindowMs]);

  const getPlayer = (): LoopPlayer => {
    if (!playerRef.current) playerRef.current = new LoopPlayer();
    return playerRef.current;
  };

  // 卸载时停止播放
  useEffect(() => {
    return () => {
      playerRef.current?.stop();
    };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus('解码中…');
    try {
      const player = getPlayer();
      const buf = await decodeAudioFile(file, player.getContext());
      player.stop();
      setPlaying(null);
      setBuffer(buf);
      setFileName(file.name);
      setSelection(null);
      setCandidates([]);
      setSelectedIdx(0);
      setPeriodCandidates([]);
      setPeriodReason(null);
      setPeriodLagRange(null);
      setPeriodLock(null);
      setStatus(
        `已加载：${file.name} — ${buf.sampleRate} Hz / ${buf.numberOfChannels} 声道 / 时长 ${fmtTime(buf.duration)}。请在波形上框选大致循环区间。`,
      );
    } catch {
      setStatus('解码失败：请使用 WAV / MP3 等浏览器支持的音频格式。');
    } finally {
      setBusy(false);
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const onSelectionChange = useCallback((region: Region) => {
    setSelection(region);
    // 选区变化后旧候选失效：清空候选并禁用导出；
    // 滞后范围随选区长度变化，周期候选与锁定一并清除
    setCandidates([]);
    setSelectedIdx(0);
    setPeriodCandidates([]);
    setPeriodReason(null);
    setPeriodLagRange(null);
    setPeriodLock(null);
  }, []);

  /** 周期校准：分析整段音频的能量变化包络，给出前 3 个周期候选 */
  const runPeriodAnalysis = useCallback(() => {
    if (!buffer || !selection) {
      setStatus('请先在波形上框选大致循环区间，再进行周期校准分析。');
      return;
    }
    const sr = buffer.sampleRate;
    const res = detectPeriods(buffer, (selection.end - selection.start) * sr);
    setPeriodCandidates(res.candidates);
    setPeriodReason(res.reason);
    setPeriodLagRange(res.lagRangeSamples);
    setPeriodLock(null);
    if (res.candidates.length === 0) {
      // 短音频 / 静音 / 无显著峰：不强制吸附，提示原因并保留原选区
      setStatus(`周期校准：${PERIOD_REASON_TEXT[res.reason ?? 'no-peak']}已保留原选区。`);
      return;
    }
    const range = res.lagRangeSamples;
    setStatus(
      `周期校准：在 ${((range?.min ?? 0) / sr * 1000).toFixed(0)}～${((range?.max ?? 0) / sr * 1000).toFixed(0)} ms ` +
        `滞后范围内检测到 ${res.candidates.length} 个周期候选。点击候选可将选区终点吸附到该周期，并把接缝搜索切换为定长约束。`,
    );
  }, [buffer, selection]);

  /** 点选周期候选：选区终点吸附到该周期，接缝搜索切换为定长约束 */
  const snapToPeriod = useCallback(
    (idx: number) => {
      if (!buffer || !selection) return;
      const cand = periodCandidates[idx];
      if (!cand) return;
      const sr = buffer.sampleRate;
      const periodSec = cand.periodSamples / sr;
      let start = selection.start;
      let end = start + periodSec;
      if (end > buffer.duration) {
        // 终点越界时整体左移选区，保持周期长度不变
        end = buffer.duration;
        start = Math.max(0, end - periodSec);
      }
      setSelection({ start, end });
      setPeriodLock({ periodSamples: cand.periodSamples, confidence: cand.confidence, rank: idx + 1 });
      // 选区已变，旧接缝候选失效
      setCandidates([]);
      setSelectedIdx(0);
      setStatus(
        `已吸附到周期候选 #${idx + 1}：周期 ${(periodSec * 1000).toFixed(1)} ms，置信度 ${(cand.confidence * 100).toFixed(0)}%。` +
          ` 接缝搜索已切换为定长约束（起止点等量平移，周期样本数不变），请重新查找候选接缝。`,
      );
    },
    [buffer, selection, periodCandidates],
  );

  /** 解除周期锁定：恢复自由起止点搜索，旧候选需重新查找 */
  const clearPeriodLock = useCallback(() => {
    setPeriodLock(null);
    if (candidates.length > 0) {
      setCandidates([]);
      setSelectedIdx(0);
      setStatus('已解除周期锁定：接缝搜索恢复为自由起止点模式，候选已清空，请重新查找。');
    } else {
      setStatus('已解除周期锁定：接缝搜索恢复为自由起止点模式。');
    }
  }, [candidates.length]);

  /** 搜索半径变化：清空候选并禁用旧导出，需重新查找 */
  const onRadiusChange = (v: number) => {
    setRadiusMs(v);
    if (candidates.length > 0) {
      setStatus('搜索半径已调整，候选接缝已清空，请重新查找。');
    }
    setCandidates([]);
    setSelectedIdx(0);
  };

  /** 执行候选接缝搜索；返回候选列表（失败返回空数组） */
  const runSearch = useCallback((): SeamResult[] => {
    if (!buffer || !selection) {
      setStatus('请先在波形上框选大致循环区间。');
      return [];
    }
    const sr = buffer.sampleRate;
    const startS = selection.start * sr;
    const endS = selection.end * sr;
    if (endS - startS < MIN_LOOP_SECONDS * sr) {
      setStatus('选区太短，请框选更长的循环区间。');
      return [];
    }
    const maxRadius = Math.max(1, (endS - startS) / 2 - 64);
    const radius = Math.min((radiusMs / 1000) * sr, maxRadius);
    const found = findCandidateSeams(buffer, startS, endS, {
      radiusSamples: radius,
      slopeWindow: SLOPE_WINDOW,
      slopeWeight: SLOPE_WEIGHT,
      maxCandidates: MAX_CANDIDATES,
      // 周期锁定后使用定长约束：起止点等量平移，周期样本数不变
      fixedLoopSamples: periodLock?.periodSamples,
    });
    setCandidates(found);
    setSelectedIdx(0);
    if (found.length === 0) {
      setStatus('未找到有效接缝：请调整选区或增大搜索半径。');
      return found;
    }
    const best = found[0];
    const dStart = ((best.startSample - startS) / sr) * 1000;
    const dEnd = ((best.endSample - endS) / sr) * 1000;
    const shiftText = periodLock
      ? ` #1 起止点同步移动 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)} ms（定长约束），`
      : ` #1 起点移动 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)} ms，` +
        `终点移动 ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(1)} ms，`;
    setStatus(
      `找到 ${found.length} 个候选接缝（起止点相距不足 10 ms 的已去重，按代价排序）。` +
        shiftText +
        `代价 ${best.cost.toFixed(4)}。` +
        ` 点击候选列表可切换试听与导出目标。`,
    );
    return found;
  }, [buffer, selection, radiusMs, periodLock]);

  const playOriginal = useCallback(async () => {
    if (!buffer || !selection) {
      setStatus('请先框选循环区间。');
      return;
    }
    const sr = buffer.sampleRate;
    const pcm = buildLoopPcm(buffer, selection.start * sr, selection.end * sr, 0);
    await getPlayer().play(pcm);
    setPlaying('original');
  }, [buffer, selection]);

  /** 循环试听指定候选（idx 缺省为当前选中项；无候选时先自动搜索） */
  const playCandidate = useCallback(
    async (list: SeamResult[], idx: number) => {
      if (!buffer) return;
      const s = list[idx];
      if (!s) return;
      const pcm = buildLoopPcm(buffer, s.startSample, s.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
      await getPlayer().play(pcm);
      setPlaying('optimized');
    },
    [buffer, crossfadeMs],
  );

  const playOptimized = useCallback(async () => {
    if (!buffer) return;
    let list = candidates;
    let idx = selectedIdx;
    if (list.length === 0) {
      list = runSearch();
      idx = 0;
    }
    await playCandidate(list, idx);
  }, [buffer, candidates, selectedIdx, runSearch, playCandidate]);

  /** 点选候选：设为导出目标并循环试听；再次点击正在试听的候选则停止 */
  const onCandidateClick = useCallback(
    async (idx: number) => {
      if (idx === selectedIdx && playing === 'optimized') {
        getPlayer().stop();
        setPlaying(null);
        return;
      }
      setSelectedIdx(idx);
      await playCandidate(candidates, idx);
    },
    [candidates, selectedIdx, playing, playCandidate],
  );

  const stopPlayback = useCallback(() => {
    getPlayer().stop();
    setPlaying(null);
  }, []);

  // 交叉淡化时长变化时，若正在试听优化区间则实时重建并继续播放
  const crossfadeRef = useRef(crossfadeMs);
  useEffect(() => {
    if (crossfadeRef.current === crossfadeMs) return;
    crossfadeRef.current = crossfadeMs;
    if (playing === 'optimized') void playOptimized();
  }, [crossfadeMs, playing, playOptimized]);

  const exportJson = useCallback(() => {
    if (!buffer || !selection || !seam) return;
    const sr = buffer.sampleRate;
    const payload = {
      file: fileName,
      sampleRate: sr,
      channels: buffer.numberOfChannels,
      durationSec: buffer.duration,
      original: {
        startSec: selection.start,
        endSec: selection.end,
        startSample: Math.round(selection.start * sr),
        endSample: Math.round(selection.end * sr),
      },
      optimized: {
        startSec: seam.startSample / sr,
        endSec: seam.endSample / sr,
        startSample: seam.startSample,
        endSample: seam.endSample,
      },
      loopDurationSec: (seam.endSample - seam.startSample) / sr,
      candidates: candidates.map((c, i) => ({
        rank: i + 1,
        startSec: c.startSample / sr,
        endSec: c.endSample / sr,
        startSample: c.startSample,
        endSample: c.endSample,
        cost: c.cost,
      })),
      selectedCandidate: selectedIdx + 1,
      parameters: {
        searchRadiusMs: radiusMs,
        crossfadeMs,
        slopeWindowSamples: SLOPE_WINDOW,
        slopeWeight: SLOPE_WEIGHT,
      },
      seamCost: seam.cost,
      // 周期校准：锁定的周期与置信度；fixedLengthSearch 标记接缝搜索是否为定长约束
      periodCalibration: {
        fixedLengthSearch: periodLock !== null,
        periodSec: periodLock ? roundTo(periodLock.periodSamples / sr, 6) : null,
        periodSamples: periodLock ? periodLock.periodSamples : null,
        confidence: periodLock ? periodLock.confidence : null,
      },
      // 接缝频谱诊断：参数与结果（差值矩阵为 头 − 尾，帧按与接缝的距离配对）
      spectrumDiagnostics: spectrum
        ? {
            candidate: selectedIdx + 1,
            parameters: {
              windowMsRequested: specWindowMs,
              windowMsEffective: roundTo((spectrum.windowSamples / spectrum.sampleRate) * 1000, 3),
              windowClamped: spectrum.clamped,
              windowFunction: 'hann',
              fftSize: spectrum.fftSize,
              hopSamples: spectrum.hopSamples,
              overlapRatio: 0.75,
              bandCount: spectrum.bands,
              bandEdgesHz: spectrum.bandEdgesHz.map((f) => roundTo(f, 1)),
              frameCount: spectrum.frameOffsetsSec.length,
              alignment: 'seam-distance',
              diff: 'headDb-tailDb',
            },
            results: {
              maxAbsDiffDb: roundTo(spectrum.maxAbsDiffDb, 2),
              worstBand: spectrum.worstBand + 1,
              worstBandHz: [
                roundTo(spectrum.bandEdgesHz[spectrum.worstBand], 1),
                roundTo(spectrum.bandEdgesHz[spectrum.worstBand + 1], 1),
              ],
              bandMaxAbsDb: spectrum.bandMaxAbsDb.map((v) => roundTo(v, 2)),
              frameOffsetsMs: spectrum.frameOffsetsSec.map((t) => roundTo(t * 1000, 1)),
              diffDb: spectrum.diffDb.map((row) => row.map((v) => roundTo(v, 2))),
            },
          }
        : null,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出 JSON：候选 #${selectedIdx + 1} 的起止时间、全部候选列表、搜索参数、周期校准与接缝频谱诊断。`);
  }, [buffer, selection, seam, candidates, selectedIdx, fileName, radiusMs, crossfadeMs, spectrum, specWindowMs, periodLock]);

  const exportWav = useCallback(() => {
    if (!buffer || !seam) return;
    const pcm = buildLoopPcm(buffer, seam.startSample, seam.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
    const wav = encodeWav(pcm);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.wav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      `已导出 WAV（候选 #${selectedIdx + 1}）：16-bit PCM，含 smpl 循环区块（0 → 最后一帧），共 ${fmtBytes(wav.byteLength)}。`,
    );
  }, [buffer, seam, selectedIdx, crossfadeMs, fileName]);

  const sr = buffer?.sampleRate ?? 44100;

  // 波形上的候选标记（编号与候选列表对应）
  const candidateMarkers: SeamMarker[] = candidates.map((c, i) => ({
    start: c.startSample / sr,
    end: c.endSample / sr,
    label: String(i + 1),
    selected: i === selectedIdx,
  }));

  // 导出 WAV 的帧数与预计大小（与 buildLoopPcm 的边界夹取逻辑保持一致；
  // 交叉淡化只改写接缝区域，不改变总帧数）
  let wavFrames = 0;
  let wavBytes = 0;
  if (buffer && seam) {
    const len = buffer.length;
    const s = Math.max(0, Math.min(Math.round(seam.startSample), len - 2));
    const e = Math.max(s + 2, Math.min(Math.round(seam.endSample), len));
    wavFrames = e - s;
    wavBytes = wavFileSize(wavFrames, buffer.numberOfChannels);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>无缝循环接缝查找器</h1>
        <p>本地浏览器内分析音频：周期校准可按能量包络自相关吸附选区到整周期，接缝搜索在粗选边界附近寻找幅值与短窗斜率最连续的接缝候选（Top 5 按代价排序，锁定周期后为定长约束），可点选对比试听、查看接缝频谱诊断热图并导出参数。</p>
      </header>

      <section
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3"
          style={{ display: 'none' }}
          onChange={onInputChange}
        />
        <strong>{busy ? '解码中…' : fileName || '点击选择或拖入 WAV / MP3 文件'}</strong>
        <span>{fileName ? '点击可重新选择文件' : '音频不会上传，全部在本地处理'}</span>
      </section>

      {buffer && (
        <>
          <Waveform buffer={buffer} selection={selection} markers={candidateMarkers} onSelectionChange={onSelectionChange} />
          <div className="legend">
            <span><i className="swatch swatch-handle" /> 选区边界（可拖动）</span>
            <span><i className="swatch swatch-seam" /> 候选接缝（编号与列表对应，高亮为选中）</span>
          </div>

          <PeriodPanel
            candidates={periodCandidates}
            reason={periodReason}
            lagRange={periodLagRange}
            lock={periodLock}
            sampleRate={sr}
            hasSelection={selection !== null}
            onAnalyze={runPeriodAnalysis}
            onPick={snapToPeriod}
            onClearLock={clearPeriodLock}
          />

          <section className="panel">
            <div className="sliders">
              <label>
                <span>搜索半径：<b>{radiusMs} ms</b></span>
                <input
                  type="range"
                  min={5}
                  max={500}
                  step={5}
                  value={radiusMs}
                  onChange={(e) => onRadiusChange(Number(e.target.value))}
                />
              </label>
              <label>
                <span>交叉淡化：<b>{crossfadeMs} ms</b></span>
                <input
                  type="range"
                  min={0}
                  max={500}
                  step={5}
                  value={crossfadeMs}
                  onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="transport">
              <button className="primary" onClick={() => runSearch()}>查找候选接缝</button>
              <button
                className={playing === 'original' ? 'active' : ''}
                onClick={() => (playing === 'original' ? stopPlayback() : void playOriginal())}
              >
                {playing === 'original' ? '■ 停止' : '▶ 试听原区间'}
              </button>
              <button
                className={playing === 'optimized' ? 'active' : ''}
                onClick={() => (playing === 'optimized' ? stopPlayback() : void playOptimized())}
              >
                {playing === 'optimized' ? '■ 停止' : '▶ 试听选中候选'}
              </button>
              <button onClick={stopPlayback} disabled={playing === null}>停止</button>
              <button onClick={exportJson} disabled={!seam || !selection}>下载 JSON</button>
              <button onClick={exportWav} disabled={!seam}>下载 WAV</button>
            </div>

            {seam && buffer && (
              <p className="export-info">
                WAV 导出（候选 #{selectedIdx + 1}）：{buffer.sampleRate} Hz · {buffer.numberOfChannels} 声道 ·{' '}
                {wavFrames.toLocaleString()} 帧 · 预计 {fmtBytes(wavBytes)}
                （16-bit PCM，含 smpl 循环区块）
              </p>
            )}
          </section>

          {candidates.length > 0 && (
            <section className="panel candidates">
              <h2>候选接缝（按代价排序）— 点击行循环试听，选中项即为导出目标</h2>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>起点</th>
                    <th>终点</th>
                    <th>循环时长</th>
                    <th>代价</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => (
                    <tr
                      key={i}
                      className={i === selectedIdx ? 'selected' : ''}
                      onClick={() => void onCandidateClick(i)}
                    >
                      <td><span className="rank">{i + 1}</span></td>
                      <td>{fmtTime(c.startSample / sr)}</td>
                      <td>{fmtTime(c.endSample / sr)}</td>
                      <td>{fmtTime((c.endSample - c.startSample) / sr)}</td>
                      <td>{c.cost.toFixed(4)}</td>
                      <td className="row-state">
                        {i === selectedIdx
                          ? playing === 'optimized'
                            ? '■ 试听中（再点停止）'
                            : '✓ 导出目标'
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {seam && buffer && (
            <SeamSpectrumPanel
              result={spectrum}
              candidateLabel={`候选 #${selectedIdx + 1}`}
              windowMs={specWindowMs}
              onWindowMsChange={setSpecWindowMs}
            />
          )}

          <section className="panel info">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>起点</th>
                  <th>终点</th>
                  <th>循环时长</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>原区间</td>
                  <td>{selection ? fmtTime(selection.start) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end - selection.start) : '—'}</td>
                </tr>
                <tr className="optimized-row">
                  <td>优化区间{seam ? `（候选 #${selectedIdx + 1}）` : ''}</td>
                  <td>{seam ? fmtTime(seam.startSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime(seam.endSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime((seam.endSample - seam.startSample) / sr) : '—'}</td>
                </tr>
              </tbody>
            </table>
            {seam && (
              <p className="cost">
                接缝代价：{seam.cost.toFixed(4)}（候选 #{selectedIdx + 1}，越小越平滑） · 淡化 {crossfadeMs} ms · 半径 {radiusMs} ms
              </p>
            )}
          </section>
        </>
      )}

      <p className="status">{status}</p>

      <footer className="footer">
        所有音频处理均在浏览器本地完成（Web Audio API），不会上传任何数据。
      </footer>
    </div>
  );
}
