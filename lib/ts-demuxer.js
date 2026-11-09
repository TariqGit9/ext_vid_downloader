// MPEG-TS demuxer — extracts H.264 video and AAC audio from .ts segments

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC = 0x0f;

/**
 * Demux concatenated TS packets into H.264 NAL units and AAC frames.
 * @param {Uint8Array} data - raw concatenated TS bytes
 * @returns {{video: Array<{pts:number,dts:number,nalus:Uint8Array[]}>, audio: Array<{pts:number,data:Uint8Array,sampleRate:number,channels:number,objectType:number}>}}
 */
export function demuxTS(data) {
  const pmtPids = new Set();
  let pmtPid = -1;
  const streamPids = new Map(); // pid -> { type }
  let videoPid = -1;
  let audioPid = -1;

  // Buffer PES per pid until completion
  const pesBuffers = new Map(); // pid -> { buf: Uint8Array[], length: number, pts, dts, started }

  const videoFrames = [];
  const audioFrames = [];

  // First pass: find sync byte, parse PAT/PMT to discover stream PIDs
  let offset = findSyncByte(data, 0);

  for (let i = offset; i + TS_PACKET_SIZE <= data.length; i += TS_PACKET_SIZE) {
    if (data[i] !== TS_SYNC_BYTE) {
      // Try to resync
      const next = findSyncByte(data, i + 1);
      if (next < 0 || next + TS_PACKET_SIZE > data.length) break;
      i = next - TS_PACKET_SIZE;
      continue;
    }

    const tei = (data[i + 1] & 0x80) !== 0;
    if (tei) continue;
    const payloadUnitStart = (data[i + 1] & 0x40) !== 0;
    const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
    const adaptationField = (data[i + 3] & 0x30) >> 4;
    const hasPayload = (adaptationField & 0x01) !== 0;
    const hasAdaptation = (adaptationField & 0x02) !== 0;

    let payloadOffset = i + 4;
    if (hasAdaptation) {
      const adLen = data[i + 4];
      payloadOffset = i + 5 + adLen;
    }
    if (!hasPayload || payloadOffset >= i + TS_PACKET_SIZE) continue;

    const payload = data.subarray(payloadOffset, i + TS_PACKET_SIZE);

    if (pid === 0) {
      // PAT
      parsePAT(payload, payloadUnitStart, pmtPids);
      if (pmtPids.size > 0 && pmtPid === -1) pmtPid = [...pmtPids][0];
    } else if (pid === pmtPid) {
      // PMT
      const pmt = parsePMT(payload, payloadUnitStart);
      if (pmt) {
        for (const s of pmt.streams) {
          streamPids.set(s.pid, { type: s.type });
          if (s.type === STREAM_TYPE_H264 && videoPid === -1) videoPid = s.pid;
          else if (s.type === STREAM_TYPE_AAC && audioPid === -1) audioPid = s.pid;
        }
      }
    } else if (pid === videoPid || pid === audioPid) {
      handlePESPayload(
        pesBuffers,
        pid,
        payload,
        payloadUnitStart,
        pid === videoPid ? videoFrames : audioFrames,
        pid === videoPid ? "video" : "audio"
      );
    }
  }

  // Flush remaining PES buffers
  for (const [pid, buf] of pesBuffers.entries()) {
    if (buf.started && buf.buf.length > 0) {
      flushPES(buf, pid === videoPid ? videoFrames : audioFrames, pid === videoPid ? "video" : "audio");
    }
  }

  return { video: videoFrames, audio: audioFrames };
}

function findSyncByte(data, start) {
  for (let i = start; i < data.length; i++) {
    if (data[i] === TS_SYNC_BYTE) {
      if (i + TS_PACKET_SIZE * 2 < data.length && data[i + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
        return i;
      }
      if (i + TS_PACKET_SIZE >= data.length) return i;
    }
  }
  return -1;
}

function parsePAT(payload, start, pmtPids) {
  if (!start) return;
  const pointer = payload[0];
  let p = 1 + pointer;
  if (payload[p] !== 0x00) return; // table_id
  const sectionLength = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
  // Skip header (8 bytes)
  let i = p + 8;
  const end = p + 3 + sectionLength - 4; // -4 for CRC
  while (i + 3 < end && i + 3 < payload.length) {
    const programNumber = (payload[i] << 8) | payload[i + 1];
    const pid = ((payload[i + 2] & 0x1f) << 8) | payload[i + 3];
    if (programNumber !== 0) pmtPids.add(pid);
    i += 4;
  }
}

function parsePMT(payload, start) {
  if (!start) return null;
  const pointer = payload[0];
  let p = 1 + pointer;
  if (payload[p] !== 0x02) return null;
  const sectionLength = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
  const programInfoLength = ((payload[p + 10] & 0x0f) << 8) | payload[p + 11];
  let i = p + 12 + programInfoLength;
  const end = p + 3 + sectionLength - 4;
  const streams = [];
  while (i + 4 < end && i + 4 < payload.length) {
    const streamType = payload[i];
    const elemPid = ((payload[i + 1] & 0x1f) << 8) | payload[i + 2];
    const esInfoLength = ((payload[i + 3] & 0x0f) << 8) | payload[i + 4];
    streams.push({ type: streamType, pid: elemPid });
    i += 5 + esInfoLength;
  }
  return { streams };
}

function handlePESPayload(pesBuffers, pid, payload, start, frames, kind) {
  let buf = pesBuffers.get(pid);
  if (start) {
    if (buf && buf.started && buf.buf.length > 0) {
      flushPES(buf, frames, kind);
    }
    buf = { buf: [], length: 0, pts: 0, dts: 0, started: false };
    pesBuffers.set(pid, buf);

    // Parse PES header
    if (payload.length < 9) return;
    if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return;
    const ptsDtsFlags = (payload[7] & 0xc0) >> 6;
    const pesHeaderDataLen = payload[8];
    let pts = 0,
      dts = 0;
    if (ptsDtsFlags & 0x02) {
      pts = readTimestamp(payload, 9);
    }
    if (ptsDtsFlags === 0x03) {
      dts = readTimestamp(payload, 14);
    } else {
      dts = pts;
    }
    const dataStart = 9 + pesHeaderDataLen;
    buf.pts = pts;
    buf.dts = dts;
    buf.started = true;
    if (dataStart < payload.length) {
      const piece = payload.subarray(dataStart);
      buf.buf.push(piece);
      buf.length += piece.length;
    }
  } else if (buf && buf.started) {
    buf.buf.push(payload);
    buf.length += payload.length;
  }
}

function readTimestamp(payload, off) {
  return (
    (payload[off] & 0x0e) * 536870912 +
    (payload[off + 1] & 0xff) * 2097152 +
    (payload[off + 2] & 0xfe) * 16384 +
    (payload[off + 3] & 0xff) * 64 +
    (payload[off + 4] & 0xfe) / 4
  );
}

function flushPES(buf, frames, kind) {
  // Concatenate
  const merged = new Uint8Array(buf.length);
  let o = 0;
  for (const part of buf.buf) {
    merged.set(part, o);
    o += part.length;
  }

  if (kind === "video") {
    const nalus = splitNALUs(merged);
    if (nalus.length > 0) {
      frames.push({ pts: buf.pts, dts: buf.dts, nalus });
    }
  } else if (kind === "audio") {
    // AAC ADTS frames
    const aacFrames = splitADTS(merged, buf.pts);
    for (const f of aacFrames) frames.push(f);
  }
}

function splitNALUs(data) {
  const nalus = [];
  let i = 0;
  let lastStart = -1;
  while (i < data.length - 3) {
    let startLen = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) startLen = 3;
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) startLen = 4;
    if (startLen) {
      if (lastStart >= 0) {
        nalus.push(data.subarray(lastStart, i));
      }
      lastStart = i + startLen;
      i += startLen;
    } else {
      i++;
    }
  }
  if (lastStart >= 0 && lastStart < data.length) {
    nalus.push(data.subarray(lastStart));
  }
  return nalus;
}

function splitADTS(data, basePts) {
  const frames = [];
  let i = 0;
  let frameIdx = 0;
  while (i + 7 < data.length) {
    if (data[i] !== 0xff || (data[i + 1] & 0xf0) !== 0xf0) {
      i++;
      continue;
    }
    const protAbsent = (data[i + 1] & 0x01) !== 0;
    const objectType = ((data[i + 2] & 0xc0) >> 6) + 1;
    const sampleRateIdx = (data[i + 2] & 0x3c) >> 2;
    const channelCfg = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] & 0xc0) >> 6);
    const frameLength =
      ((data[i + 3] & 0x03) << 11) |
      (data[i + 4] << 3) |
      ((data[i + 5] & 0xe0) >> 5);
    if (frameLength < 7 || i + frameLength > data.length) break;

    const headerLen = protAbsent ? 7 : 9;
    const audioData = data.subarray(i + headerLen, i + frameLength);

    const sampleRate = AAC_SAMPLE_RATES[sampleRateIdx] || 48000;
    // Each AAC frame = 1024 samples
    const pts = basePts + (frameIdx * 1024 * 90000) / sampleRate;
    frames.push({
      pts,
      data: audioData,
      sampleRate,
      sampleRateIdx,
      channels: channelCfg,
      objectType,
    });

    i += frameLength;
    frameIdx++;
  }
  return frames;
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
