/* Who has the floor: who is talking right now, from Discord's speaking signal (a speaker "starts" with their first
   audio packet and "ends" 100 ms after their last; checked in @discordjs/voice's SpeakingMap, 0.19.2). Free: nothing is
   heard or paid for. Angel asks it whether the table is busy and waits on it for a gap before she speaks (Rhea,
   2026-11-15, design d-7); chiming in will use the same piece.
   - A blip (a cough, "mm") shorter than `blipMs` doesn't count.
   - A pause shorter than `mergeMs` between one speaker's words is the same stretch of talk.
   - Talk that began while Angel herself was speaking, or within `echoTailMs` after, counts only from the end of
     that window: her voice can come back through a microphone and mark that player as talking. */
export class Floor {
  constructor({ now = Date.now, blipMs = 500, mergeMs = 400, echoTailMs = 500, ownSpeech = () => [], pollMs = 100, maxSpellMs = 10 * 60000 } = {}) {
    Object.assign(this, { now, blipMs, mergeMs, echoTailMs, ownSpeech, pollMs, maxSpellMs });
    this.spells = new Map(); /* userId → [{ start, end }] (end null while they talk), oldest first */
  }

  /* from the voice link: `speaking` true when they start, false when they stop */
  talk(userId, speaking, at = this.now()) {
    let list = this.spells.get(userId);
    if (!list) { list = []; this.spells.set(userId, list); }
    const last = list.at(-1);
    if (speaking) {
      /* an end lost long ago: close it, so this start counts */
      if (last && last.end === null && !this.open(last, at)) last.end = this.endOf(last, at);
      if (last && last.end === null) return;
      /* a short pause between words: the same stretch of talk */
      if (last && at - last.end < this.mergeMs) { last.end = null; return; }
      list.push({ start: at, end: null });
      /* only the last minutes matter */
      while (list.length > 1 && at - (list[0].end ?? at) > 5 * 60000) list.shift();
    } else if (last && last.end === null) {
      last.end = at;
    }
  }

  /* someone leaving the channel, or the session ending: they are not talking any more */
  forget(userId) { this.spells.delete(userId); }

  /* the part of a stretch of talk that counts: from the end of Angel's own speech (plus the tail) when it began in it */
  counted(spell, at) {
    const start = this.effectiveStart(spell, at);
    const end = this.endOf(spell, at);
    return end - start >= this.blipMs ? { start, end } : null;
  }

  /* Is the table busy: someone in a stretch of talk that counts, still talking (or paused shorter than mergeMs)? */
  busy(at = this.now()) {
    for (const list of this.spells.values()) {
      const last = list.at(-1);
      if (!last || (!this.open(last, at) && at - this.endOf(last, at) >= this.mergeMs)) continue;
      if (this.counted(last, at)) return true;
    }
    return false;
  }

  /* Who is talking now (counted stretches only), for the log */
  talkers(at = this.now()) {
    return [...this.spells.entries()].filter(([, list]) => { const l = list.at(-1); return l && this.open(l, at) && this.counted(l, at); }).map(([id]) => id);
  }

  /* How long nobody has talked, counted from `since` at the earliest. Anyone mid-word (even a blip so far) means 0. */
  quietFor(at = this.now(), since = -Infinity) {
    let lastEnd = since;
    for (const list of this.spells.values()) {
      for (const spell of list) {
        if (this.open(spell, at)) {
          /* talking now: not quiet, unless all of it so far is her own voice coming back */
          if (this.effectiveStart(spell, at) <= at) return 0;
          continue;
        }
        const c = this.counted(spell, at);
        if (c && c.end > lastEnd) lastEnd = c.end;
      }
    }
    return Math.max(0, at - lastEnd);
  }

  /* a stretch still open after maxSpellMs lost its end somewhere: it is taken as ended then, so the table can't stay
     busy for good (review of 0.1.3) */
  endOf(spell, at) {
    if (spell.end !== null) return spell.end;
    return at - spell.start > this.maxSpellMs ? spell.start + this.maxSpellMs : at;
  }
  open(spell, at) { return spell.end === null && at - spell.start <= this.maxSpellMs; }

  /* How long since anyone made any sound at all, a blip included (her own voice coming back aside) */
  sinceAnyTalk(at = this.now()) {
    let lastEnd = -Infinity;
    for (const list of this.spells.values()) {
      for (const spell of list) {
        const end = this.endOf(spell, at);
        if (this.effectiveStart(spell, at) > end) continue; /* all inside her own echo window */
        if (this.open(spell, at)) return 0;
        if (end > lastEnd) lastEnd = end;
      }
    }
    return at - lastEnd;
  }

  /* when a stretch of talk starts to count: talk that began while she spoke (or in the tail after) counts from the
     end of that window */
  effectiveStart(spell, at) {
    let start = spell.start;
    for (const [s, e] of this.ownSpeech()) {
      const end = (e ?? at) + this.echoTailMs;
      if (start >= s && start <= end) start = end;
    }
    return start;
  }

  /* Wait until nobody has talked for `needMs` (counted from `since`), at most `maxMs`. Returns { promise, wake }:
     the promise resolves "quiet", "timeout", or whatever `wake(reason)` was given. needMs Infinity waits for wake or
     the timeout only. `blocked()` true holds a quiet back (the timeout and wakes still count). */
  waitForQuiet(needMs, { maxMs = Infinity, since = -Infinity, blocked = () => false, minSinceAnyMs = 0 } = {}) {
    const began = this.now();
    let timer = null, done = null;
    const promise = new Promise(resolve => {
      done = reason => { done = null; clearTimeout(timer); resolve(reason); };
      const tick = () => {
        if (!done) return;
        const at = this.now();
        /* `blocked`: something said in the quiet is still being heard or judged (the caller's to say) */
        if (needMs !== Infinity && this.quietFor(at, since) >= needMs && this.sinceAnyTalk(at) >= minSinceAnyMs && !blocked()) return done("quiet");
        if (at - began >= maxMs) return done("timeout");
        /* not unref'd: a hold always has a limit (busyMaxHoldMs), and a session waiting on it is real work */
        timer = setTimeout(tick, this.pollMs);
      };
      tick();
    });
    return { promise, wake: reason => done?.(reason) };
  }
}
