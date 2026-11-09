// Fragmented MP4 muxer — packages H.264 + AAC into a fragmented MP4 (fmp4)
// Output is playable in VLC, Chrome, and most players.

import { demuxTS } from "./ts-demuxer.js";

const TIMESCALE_VIDEO = 90000;
const TIMESCALE_AUDIO_DEFAULT = 48000;

/**
 * Convert raw concatenated TS bytes to a fragmented MP4 Blob.
 * @param {Uint8Array} tsData
 * @returns {Promise<Uint8Array>} mp4 bytes
 */
export async function transmuxTStoMP4(tsData) {
  const { video, audio } = demuxTS(tsData);

  if (video.length === 0 && audio.length === 0) {
    throw new Error("No video or audio streams found in TS data");
  }

  // Find SPS/PPS from video NALUs
  let sps = null,
    pps = null;
  let videoWidth = 0,
    videoHeight = 0;
  for (const f of video) {
    for (const n of f.nalus) {
      const nalType = n[0] & 0x1f;
      if (nalType === 7 && !sps) {
        sps = n;
        const dims = parseSPSDimensions(n);
        if (dims) {
          videoWidth = dims.width;
          videoHeight = dims.height;
        }
      } else if (nalType === 8 && !pps) {
        pps = n;
      }
    }
    if (sps && pps) break;
  }

  // Build video samples (length-prefixed AVCC format)
  const videoSamples = [];
  for (const frame of video) {
    let totalLen = 0;
    const filteredNalus = [];
    for (const n of frame.nalus) {
      const nalType = n[0] & 0x1f;
      // Skip SPS/PPS in samples — they go in avcC config
      if (nalType === 7 || nalType === 8 || nalType === 9) continue;
      filteredNalus.push(n);
      totalLen += 4 + n.length;
    }
    if (filteredNalus.length === 0) continue;
    const sample = new Uint8Array(totalLen);
    let off = 0;
    let isKeyframe = false;
    for (const n of filteredNalus) {
      if ((n[0] & 0x1f) === 5) isKeyframe = true;
      sample[off] = (n.length >>> 24) & 0xff;
      sample[off + 1] = (n.length >>> 16) & 0xff;
      sample[off + 2] = (n.length >>> 8) & 0xff;
      sample[off + 3] = n.length & 0xff;
      sample.set(n, off + 4);
      off += 4 + n.length;
    }
    videoSamples.push({
      data: sample,
      pts: frame.pts,
      dts: frame.dts,
      isKeyframe,
    });
  }

  // Compute video sample durations from DTS deltas
  for (let i = 0; i < videoSamples.length; i++) {
    const next = videoSamples[i + 1];
    videoSamples[i].duration = next
      ? Math.max(1, Math.round(next.dts - videoSamples[i].dts))
      : Math.round(TIMESCALE_VIDEO / 30); // fallback ~30fps
    videoSamples[i].cts = Math.max(0, Math.round(videoSamples[i].pts - videoSamples[i].dts));
  }

  // Audio info from first AAC frame
  let audioSampleRate = TIMESCALE_AUDIO_DEFAULT;
  let audioChannels = 2;
  let audioObjectType = 2;
  let audioSampleRateIdx = 3;
  if (audio.length > 0) {
    audioSampleRate = audio[0].sampleRate;
    audioChannels = audio[0].channels || 2;
    audioObjectType = audio[0].objectType || 2;
    audioSampleRateIdx = audio[0].sampleRateIdx ?? 3;
  }

  const audioSamples = audio.map((f, i) => {
    const next = audio[i + 1];
    return {
      data: f.data,
      pts: f.pts,
      duration: 1024, // AAC frame is always 1024 samples
    };
  });

  const hasVideo = videoSamples.length > 0 && sps && pps;
  const hasAudio = audioSamples.length > 0;

  if (!hasVideo && !hasAudio) {
    throw new Error("No usable media after demux");
  }

  // Build moov (initialization) box
  const ftyp = box("ftyp", concat([
    str("isom"),
    u32(0x00000200),
    str("isom"),
    str("iso2"),
    str("avc1"),
    str("mp41"),
  ]));

  const tracks = [];
  if (hasVideo) {
    tracks.push(buildVideoTrack(1, sps, pps, videoWidth, videoHeight));
  }
  if (hasAudio) {
    tracks.push(
      buildAudioTrack(
        hasVideo ? 2 : 1,
        audioSampleRate,
        audioChannels,
        audioObjectType,
        audioSampleRateIdx
      )
    );
  }

  const moov = buildMoov(tracks);

  // Build moof + mdat fragments
  const fragments = [];
  let seqNum = 1;
  let videoBaseDecodeTime = 0;
  let audioBaseDecodeTime = 0;

  if (hasVideo) {
    const { moof, mdat } = buildVideoFragment(
      seqNum++,
      1,
      videoSamples,
      videoBaseDecodeTime
    );
    fragments.push(moof, mdat);
  }
  if (hasAudio) {
    // Audio base time in audio timescale
    const audioBase = Math.round(((audio[0]?.pts || 0) * audioSampleRate) / 90000);
    const { moof, mdat } = buildAudioFragment(
      seqNum++,
      hasVideo ? 2 : 1,
      audioSamples,
      audioBase,
      audioSampleRate
    );
    fragments.push(moof, mdat);
  }

  // Concatenate all
  const parts = [ftyp, moov, ...fragments];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// === Box building helpers ===

function box(type, ...children) {
  const payload = concat(children.flat ? children.flat() : children);
  const result = new Uint8Array(8 + payload.length);
  const size = result.length;
  result[0] = (size >>> 24) & 0xff;
  result[1] = (size >>> 16) & 0xff;
  result[2] = (size >>> 8) & 0xff;
  result[3] = size & 0xff;
  result.set(str(type), 4);
  result.set(payload, 8);
  return result;
}

function fullBox(type, version, flags, ...children) {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >>> 16) & 0xff;
  header[2] = (flags >>> 8) & 0xff;
  header[3] = flags & 0xff;
  return box(type, header, ...children);
}

function str(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function u8(v) {
  return new Uint8Array([v & 0xff]);
}

function u16(v) {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function u32(v) {
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

function u64(v) {
  // Limited to safe integer range
  const high = Math.floor(v / 0x100000000);
  const low = v >>> 0;
  return new Uint8Array([
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ]);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// === MOOV ===

function buildMoov(tracks) {
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0), // creation
    u32(0), // modification
    u32(1000), // timescale
    u32(0), // duration (0 = unknown for fragmented)
    u32(0x00010000), // rate
    u16(0x0100), // volume
    u16(0), // reserved
    u32(0), u32(0), // reserved
    // unity matrix
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
    u32(tracks.length + 1) // next_track_ID
  );

  const mvex = box("mvex", ...tracks.map((t) => buildTrex(t.trackId)));

  return box("moov", mvhd, ...tracks.map((t) => t.trak), mvex);
}

function buildTrex(trackId) {
  return fullBox(
    "trex",
    0,
    0,
    u32(trackId),
    u32(1), // default_sample_description_index
    u32(0), // default_sample_duration
    u32(0), // default_sample_size
    u32(0)  // default_sample_flags
  );
}

function buildVideoTrack(trackId, sps, pps, width, height) {
  const tkhd = fullBox(
    "tkhd",
    0,
    0x000007, // track_enabled, track_in_movie, track_in_preview
    u32(0), u32(0), // creation, modification
    u32(trackId),
    u32(0), // reserved
    u32(0), // duration
    u32(0), u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (0 for video)
    u16(0), // reserved
    // unity matrix
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32((width || 0) << 16),
    u32((height || 0) << 16)
  );

  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0), u32(0),
    u32(TIMESCALE_VIDEO),
    u32(0),
    u16(0x55c4), // language 'und'
    u16(0)
  );

  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    str("vide"),
    u32(0), u32(0), u32(0),
    str("VideoHandler\0")
  );

  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));

  const dref = fullBox(
    "dref",
    0,
    0,
    u32(1),
    fullBox("url ", 0, 1)
  );
  const dinf = box("dinf", dref);

  // avcC config
  const avcC = buildAvcC(sps, pps);

  const avc1 = box(
    "avc1",
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined
    u16(width || 0),
    u16(height || 0),
    u32(0x00480000), // h-resolution 72dpi
    u32(0x00480000), // v-resolution
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC
  );

  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stts = fullBox("stts", 0, 0, u32(0));
  const stsc = fullBox("stsc", 0, 0, u32(0));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(0));
  const stco = fullBox("stco", 0, 0, u32(0));

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);

  const trak = box("trak", tkhd, mdia);
  return { trackId, trak, kind: "video" };
}

function buildAvcC(sps, pps) {
  const profileIdc = sps[1];
  const profileCompat = sps[2];
  const levelIdc = sps[3];

  const parts = [
    u8(0x01),           // configuration version
    u8(profileIdc),
    u8(profileCompat),
    u8(levelIdc),
    u8(0xff),           // 6 bits reserved + lengthSizeMinusOne = 3
    u8(0xe1),           // 3 bits reserved + numOfSPS = 1
    u16(sps.length),
    sps,
    u8(0x01),           // numOfPPS
    u16(pps.length),
    pps,
  ];

  return box("avcC", ...parts);
}

function buildAudioTrack(trackId, sampleRate, channels, objectType, sampleRateIdx) {
  const tkhd = fullBox(
    "tkhd",
    0,
    0x000007,
    u32(0), u32(0),
    u32(trackId),
    u32(0),
    u32(0),
    u32(0), u32(0),
    u16(0), u16(0),
    u16(0x0100), // volume
    u16(0),
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(0), u32(0)
  );

  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0), u32(0),
    u32(sampleRate),
    u32(0),
    u16(0x55c4),
    u16(0)
  );

  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    str("soun"),
    u32(0), u32(0), u32(0),
    str("SoundHandler\0")
  );

  const smhd = fullBox("smhd", 0, 0, u16(0), u16(0));
  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1));
  const dinf = box("dinf", dref);

  const esds = buildEsds(objectType, sampleRateIdx, channels);

  const mp4a = box(
    "mp4a",
    new Uint8Array(6),
    u16(1), // data_reference_index
    u32(0), u32(0), // reserved
    u16(channels),
    u16(16), // sample size
    u16(0), u16(0),
    u32(sampleRate << 16),
    esds
  );

  const stsd = fullBox("stsd", 0, 0, u32(1), mp4a);
  const stts = fullBox("stts", 0, 0, u32(0));
  const stsc = fullBox("stsc", 0, 0, u32(0));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(0));
  const stco = fullBox("stco", 0, 0, u32(0));

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", smhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);

  const trak = box("trak", tkhd, mdia);
  return { trackId, trak, kind: "audio" };
}

function buildEsds(objectType, sampleRateIdx, channels) {
  // AudioSpecificConfig: 5 bits objectType, 4 bits sampleRateIdx, 4 bits channelCfg, 3 bits unused
  const asc1 = (objectType << 3) | (sampleRateIdx >> 1);
  const asc2 = ((sampleRateIdx & 0x01) << 7) | (channels << 3);
  const audioConfig = new Uint8Array([asc1, asc2]);

  // ES_Descriptor
  const decSpecificInfo = concat([
    u8(0x05),
    u8(audioConfig.length),
    audioConfig,
  ]);

  const decoderConfigDescr = concat([
    u8(0x04),
    u8(13 + decSpecificInfo.length),
    u8(0x40), // MPEG-4 Audio
    u8(0x15), // streamType=AudioStream + upStream=0 + reserved
    u8(0), u8(0), u8(0), // bufferSizeDB
    u32(0), // maxBitrate
    u32(0), // avgBitrate
    decSpecificInfo,
  ]);

  const slConfigDescr = new Uint8Array([0x06, 0x01, 0x02]);

  const esDescr = concat([
    u8(0x03),
    u8(3 + decoderConfigDescr.length + slConfigDescr.length),
    u16(0), // ES_ID
    u8(0), // flags
    decoderConfigDescr,
    slConfigDescr,
  ]);

  return fullBox("esds", 0, 0, esDescr);
}

// === Fragments (moof + mdat) ===

function buildVideoFragment(seqNum, trackId, samples, baseDecodeTime) {
  const mfhd = fullBox("mfhd", 0, 0, u32(seqNum));

  const tfhd = fullBox(
    "tfhd",
    0,
    0x020000, // default-base-is-moof flag
    u32(trackId)
  );

  const tfdt = fullBox("tfdt", 1, 0, u64(Math.max(0, baseDecodeTime)));

  // trun: data_offset + sample_duration + sample_size + sample_flags + sample_composition_time_offset
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const sampleEntries = new Uint8Array(samples.length * 16);
  let mdatSize = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const off = i * 16;
    // duration
    sampleEntries[off] = (s.duration >>> 24) & 0xff;
    sampleEntries[off + 1] = (s.duration >>> 16) & 0xff;
    sampleEntries[off + 2] = (s.duration >>> 8) & 0xff;
    sampleEntries[off + 3] = s.duration & 0xff;
    // size
    const sz = s.data.length;
    sampleEntries[off + 4] = (sz >>> 24) & 0xff;
    sampleEntries[off + 5] = (sz >>> 16) & 0xff;
    sampleEntries[off + 6] = (sz >>> 8) & 0xff;
    sampleEntries[off + 7] = sz & 0xff;
    // flags
    const flags = s.isKeyframe ? 0x02000000 : 0x01010000;
    sampleEntries[off + 8] = (flags >>> 24) & 0xff;
    sampleEntries[off + 9] = (flags >>> 16) & 0xff;
    sampleEntries[off + 10] = (flags >>> 8) & 0xff;
    sampleEntries[off + 11] = flags & 0xff;
    // cts
    sampleEntries[off + 12] = (s.cts >>> 24) & 0xff;
    sampleEntries[off + 13] = (s.cts >>> 16) & 0xff;
    sampleEntries[off + 14] = (s.cts >>> 8) & 0xff;
    sampleEntries[off + 15] = s.cts & 0xff;

    mdatSize += sz;
  }

  // We need to fill in data_offset after we know moof size — placeholder for now
  const trunBody = concat([
    u32(samples.length),
    u32(0), // data_offset placeholder
    sampleEntries,
  ]);
  const trun = fullBox("trun", 0, trunFlags, trunBody);

  const traf = box("traf", tfhd, tfdt, trun);
  let moof = box("moof", mfhd, traf);

  // Fix data_offset to point right after moof header
  const dataOffset = moof.length + 8;
  // Find trun in the moof and patch the data_offset (16 bytes into trun payload after fullbox header)
  // Easier: rebuild trun with correct offset
  const trunBody2 = concat([
    u32(samples.length),
    u32(dataOffset),
    sampleEntries,
  ]);
  const trun2 = fullBox("trun", 0, trunFlags, trunBody2);
  const traf2 = box("traf", tfhd, tfdt, trun2);
  moof = box("moof", mfhd, traf2);

  // mdat
  const mdat = new Uint8Array(8 + mdatSize);
  const totalLen = mdat.length;
  mdat[0] = (totalLen >>> 24) & 0xff;
  mdat[1] = (totalLen >>> 16) & 0xff;
  mdat[2] = (totalLen >>> 8) & 0xff;
  mdat[3] = totalLen & 0xff;
  mdat.set(str("mdat"), 4);
  let off = 8;
  for (const s of samples) {
    mdat.set(s.data, off);
    off += s.data.length;
  }

  return { moof, mdat };
}

function buildAudioFragment(seqNum, trackId, samples, baseDecodeTime) {
  const mfhd = fullBox("mfhd", 0, 0, u32(seqNum));

  const tfhd = fullBox(
    "tfhd",
    0,
    0x020000,
    u32(trackId)
  );

  const tfdt = fullBox("tfdt", 1, 0, u64(Math.max(0, baseDecodeTime)));

  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  const sampleEntries = new Uint8Array(samples.length * 12);
  let mdatSize = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const off = i * 12;
    sampleEntries[off] = (s.duration >>> 24) & 0xff;
    sampleEntries[off + 1] = (s.duration >>> 16) & 0xff;
    sampleEntries[off + 2] = (s.duration >>> 8) & 0xff;
    sampleEntries[off + 3] = s.duration & 0xff;
    const sz = s.data.length;
    sampleEntries[off + 4] = (sz >>> 24) & 0xff;
    sampleEntries[off + 5] = (sz >>> 16) & 0xff;
    sampleEntries[off + 6] = (sz >>> 8) & 0xff;
    sampleEntries[off + 7] = sz & 0xff;
    const flags = 0x02000000;
    sampleEntries[off + 8] = (flags >>> 24) & 0xff;
    sampleEntries[off + 9] = (flags >>> 16) & 0xff;
    sampleEntries[off + 10] = (flags >>> 8) & 0xff;
    sampleEntries[off + 11] = flags & 0xff;
    mdatSize += sz;
  }

  const trunBody = concat([
    u32(samples.length),
    u32(0),
    sampleEntries,
  ]);
  let trun = fullBox("trun", 0, trunFlags, trunBody);
  let traf = box("traf", tfhd, tfdt, trun);
  let moof = box("moof", mfhd, traf);

  const dataOffset = moof.length + 8;
  const trunBody2 = concat([
    u32(samples.length),
    u32(dataOffset),
    sampleEntries,
  ]);
  trun = fullBox("trun", 0, trunFlags, trunBody2);
  traf = box("traf", tfhd, tfdt, trun);
  moof = box("moof", mfhd, traf);

  const mdat = new Uint8Array(8 + mdatSize);
  const totalLen = mdat.length;
  mdat[0] = (totalLen >>> 24) & 0xff;
  mdat[1] = (totalLen >>> 16) & 0xff;
  mdat[2] = (totalLen >>> 8) & 0xff;
  mdat[3] = totalLen & 0xff;
  mdat.set(str("mdat"), 4);
  let off = 8;
  for (const s of samples) {
    mdat.set(s.data, off);
    off += s.data.length;
  }

  return { moof, mdat };
}

// === SPS dimension parser ===

function parseSPSDimensions(sps) {
  try {
    const rbsp = removeEmulationBytes(sps.subarray(1)); // skip nal header
    const reader = new BitReader(rbsp);
    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint flags + reserved
    reader.readBits(8); // level_idc
    reader.readUE(); // seq_parameter_set_id

    if (
      profileIdc === 100 || profileIdc === 110 || profileIdc === 122 ||
      profileIdc === 244 || profileIdc === 44 || profileIdc === 83 ||
      profileIdc === 86 || profileIdc === 118 || profileIdc === 128
    ) {
      const chromaFormatIdc = reader.readUE();
      if (chromaFormatIdc === 3) reader.readBits(1);
      reader.readUE(); // bit_depth_luma_minus8
      reader.readUE(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBits(1);
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (reader.readBits(1)) {
            // skip scaling list — give up parsing
            return null;
          }
        }
      }
    }

    reader.readUE(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUE();
    if (picOrderCntType === 0) {
      reader.readUE();
    } else if (picOrderCntType === 1) {
      reader.readBits(1);
      reader.readSE();
      reader.readSE();
      const num = reader.readUE();
      for (let i = 0; i < num; i++) reader.readSE();
    }

    reader.readUE(); // max_num_ref_frames
    reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = reader.readUE();
    const picHeightInMapUnitsMinus1 = reader.readUE();
    const frameMbsOnly = reader.readBits(1);

    const width = (picWidthInMbsMinus1 + 1) * 16;
    let height = (2 - frameMbsOnly) * (picHeightInMapUnitsMinus1 + 1) * 16;

    if (!frameMbsOnly) reader.readBits(1);
    reader.readBits(1); // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (reader.readBits(1)) {
      cropLeft = reader.readUE();
      cropRight = reader.readUE();
      cropTop = reader.readUE();
      cropBottom = reader.readUE();
    }

    return {
      width: width - 2 * (cropLeft + cropRight),
      height: height - 2 * (cropTop + cropBottom),
    };
  } catch {
    return null;
  }
}

function removeEmulationBytes(data) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (
      i + 2 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0x03
    ) {
      out.push(0, 0);
      i += 2;
    } else {
      out.push(data[i]);
    }
  }
  return new Uint8Array(out);
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.bytePos = 0;
    this.bitPos = 0;
  }
  readBits(n) {
    let result = 0;
    for (let i = 0; i < n; i++) {
      if (this.bytePos >= this.data.length) return 0;
      const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
      result = (result << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return result;
  }
  readUE() {
    let zeros = 0;
    while (this.readBits(1) === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }
  readSE() {
    const v = this.readUE();
    return v % 2 ? (v + 1) >> 1 : -(v >> 1);
  }
}
