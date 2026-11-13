/* Gathers one speaker's Opus packets into pieces of speech. Discord sends a speaker's audio only while they talk;
   @discordjs/voice ends the stream after a pause (AfterSilence). A long monologue is cut every maxPackets so the
   transcript keeps up. The library destroys a stream with an error when a packet can't be decrypted: that ends the
   piece (what was heard is kept), and onBroken lets the caller listen again if they're still talking. */

export function gather(stream, { maxPackets, onSegment, onBroken, onClosed, now = Date.now }) {
  let packets = [], startedAt = now(), done = false;
  const flush = final => {
    if (packets.length) onSegment({ packets, startedAt, final });
    packets = []; startedAt = now();
  };
  stream.on("data", packet => {
    if (done) return;
    if (!packets.length) startedAt = now();
    packets.push(packet);
    if (packets.length >= maxPackets) flush(false);
  });
  const finish = (err) => {
    if (done) return;
    done = true;
    flush(true);
    if (err && onBroken) onBroken(err);
    if (onClosed) onClosed(err);
  };
  stream.once("end", () => finish(null));
  /* `on`, not `once`: a second error with no listener would crash the process */
  stream.on("error", err => finish(err));
  stream.once("close", () => finish(null));
  return { stop: () => { if (!done) { done = true; packets = []; try { stream.destroy(); } catch { /* already gone */ } } } };
}
