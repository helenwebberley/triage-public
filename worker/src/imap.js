// A deliberately small IMAP client: just enough to read new iCloud mail and move
// it to Archive. It speaks over any { readable, writable } byte-stream pair, so
// the Worker hands it a cloudflare:sockets TLS socket and test/ hands it a fake.
//
// IMAP literals ({123}\r\n then 123 bytes) are counted in BYTES, which is why
// the buffer is a Uint8Array and lines are only decoded once they are whole.

const CRLF = [13, 10];

export class Imap {
  constructor({ readable, writable }) {
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
    this.buf = new Uint8Array(0);
    this.n = 0;
  }

  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("imap: connection closed");
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  async readLine() {
    for (;;) {
      for (let i = 0; i < this.buf.length - 1; i++) {
        if (this.buf[i] === CRLF[0] && this.buf[i + 1] === CRLF[1]) {
          const line = new TextDecoder().decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }

  async readBytes(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  // One logical response: a line, plus any literals it announces, plus the rest
  // of the line that follows each literal.
  async readResponse() {
    let text = "";
    const literals = [];
    for (;;) {
      const line = await this.readLine();
      const m = line.match(/\{(\d+)\}$/);
      if (!m) return { text: text + line, literals };
      text += line.slice(0, m.index) + `{#${literals.length}}`;
      literals.push(await this.readBytes(Number(m[1])));
    }
  }

  async greeting() {
    const r = await this.readResponse();
    if (!/^\* (OK|PREAUTH)/i.test(r.text)) throw new Error("imap: bad greeting");
  }

  async command(cmd) {
    const tag = `T${++this.n}`;
    await this.writer.write(new TextEncoder().encode(`${tag} ${cmd}\r\n`));
    const untagged = [];
    for (;;) {
      const r = await this.readResponse();
      if (r.text.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag} OK`, "i").test(r.text)) {
          // Never echo the command: for LOGIN it holds the password.
          throw new Error(`imap: ${cmd.split(" ")[0]} failed: ${r.text.slice(tag.length + 1, 200)}`);
        }
        return untagged;
      }
      untagged.push(r);
    }
  }

  async login(user, pass) {
    await this.command(`LOGIN ${quote(user)} ${quote(pass)}`);
  }

  async select(box) {
    await this.command(`SELECT ${quote(box)}`);
  }

  async searchSince(date) {
    const rows = await this.command(`UID SEARCH SINCE ${imapDate(date)}`);
    const out = [];
    for (const r of rows) {
      const m = r.text.match(/^\* SEARCH\s*(.*)$/i);
      if (m) out.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return out;
  }

  // First `bytes` of each whole message, which is plenty to read headers and the
  // opening of the body without dragging attachments over the wire.
  // The first `bytes` of each message, or all of it when bytes is 0.
  async fetchHeads(uids, bytes = 20000) {
    if (!uids.length) return [];
    const part = bytes ? `BODY.PEEK[]<0.${bytes}>` : "BODY.PEEK[]";
    const rows = await this.command(`UID FETCH ${uids.join(",")} (UID INTERNALDATE ${part})`);
    return rows
      .filter((r) => /^\* \d+ FETCH/i.test(r.text) && r.literals.length)
      .map((r) => ({
        uid: Number(r.text.match(/UID (\d+)/i)?.[1]),
        internalDate: Date.parse(r.text.match(/INTERNALDATE "([^"]+)"/i)?.[1] || "") || Date.now(),
        raw: r.literals[0],
      }));
  }

  async move(uids, box) {
    if (uids.length) await this.command(`UID MOVE ${uids.join(",")} ${quote(box)}`);
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      // The server may hang up first; nothing to do about it.
    }
  }
}

export function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function imapDate(d) {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
