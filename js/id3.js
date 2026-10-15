/*
 * Local music tag reader.
 * Supports ID3v2.2/2.3/2.4 (mp3, wav, aiff), ID3v1, MP4/M4A "ilst" atoms
 * and FLAC Vorbis comments. Everything runs in the browser on the raw bytes.
 */
(function (global) {
  'use strict';

  var decoders = {
    latin1: new TextDecoder('iso-8859-1'),
    utf8: new TextDecoder('utf-8'),
    utf16le: new TextDecoder('utf-16le'),
    utf16be: new TextDecoder('utf-16be')
  };

  function decodeSafe(decoder, bytes) {
    try {
      return decoder.decode(bytes);
    } catch (err) {
      return '';
    }
  }

  function clean(str) {
    return (str || '').replace(/\u0000/g, '').trim();
  }

  function fourCC(view, pos) {
    return String.fromCharCode(
      view.getUint8(pos), view.getUint8(pos + 1),
      view.getUint8(pos + 2), view.getUint8(pos + 3)
    );
  }

  function synchsafe(bytes, pos) {
    return ((bytes[pos] & 0x7f) << 21) | ((bytes[pos + 1] & 0x7f) << 14) |
      ((bytes[pos + 2] & 0x7f) << 7) | (bytes[pos + 3] & 0x7f);
  }

  function uint24(bytes, pos) {
    return (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
  }

  function decodeId3Text(bytes, start, end) {
    if (start >= end) return '';
    var enc = bytes[start];
    var body = bytes.subarray(start + 1, end);
    var out;
    if (enc === 0) out = decodeSafe(decoders.latin1, body);
    else if (enc === 1) out = decodeUtf16(bytes, start + 1, end);
    else if (enc === 2) out = decodeSafe(decoders.utf16be, body);
    else out = decodeSafe(decoders.utf8, body);
    return clean(out);
  }

  function decodeUtf16(bytes, start, end) {
    if (start + 1 >= end) return '';
    var bom1 = bytes[start], bom2 = bytes[start + 1];
    var body = bytes.subarray(start, end);
    if (bom1 === 0xff && bom2 === 0xfe) return decodeSafe(decoders.utf16le, body.subarray(2));
    if (bom1 === 0xfe && bom2 === 0xff) return decodeSafe(decoders.utf16be, body.subarray(2));
    return decodeSafe(decoders.utf16le, body);
  }

  /* ---------- ID3v2 ---------- */

  var ID3_FRAMES = {
    TIT2: 'title', TT2: 'title',
    TPE1: 'artist', TP1: 'artist',
    TPE2: 'albumArtist', TP2: 'albumArtist',
    TALB: 'album', TAL: 'album',
    TRCK: 'track', TRK: 'track',
    TDRC: 'year', TYER: 'year',
    TCON: 'genre', TCO: 'genre'
  };

  function readId3v2(bytes) {
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

    var major = bytes[3];
    var flags = bytes[5];
    var tagEnd = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
    if (major < 2 || major > 4) return null;

    var pos = 10;
    var out = {};

    // extended header (v2.3 = size field only, v2.4 = synchsafe incl. itself)
    if (flags & 0x40) {
      if (major === 4) pos += synchsafe(bytes, pos);
      else pos += 4 + ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
    }

    var headerSize = major === 2 ? 6 : 10;

    while (pos + headerSize <= tagEnd) {
      var id, size, dataStart;
      if (major === 2) {
        id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2]);
        size = uint24(bytes, pos + 3);
        dataStart = pos + 6;
      } else {
        id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
        size = major === 4 ? synchsafe(bytes, pos + 4) : ((bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]);
        dataStart = pos + 10;
      }
      if (!/^[A-Z0-9]{2,4}$/.test(id) || size <= 0 || dataStart + size > bytes.length) break;

      var dataEnd = dataStart + size;
      var field = ID3_FRAMES[id];
      if (field && !out[field]) out[field] = decodeId3Text(bytes, dataStart, dataEnd);

      if (id === 'APIC' || id === 'PIC') {
        var pic = readPictureFrame(bytes, dataStart, dataEnd, major === 2);
        if (pic && !out.cover) out.cover = pic;
      }
      pos = dataEnd;
    }
    return out;
  }

  function readPictureFrame(bytes, start, end, v22) {
    var enc = bytes[start];
    var mime;
    var p;
    if (v22) {
      mime = bytes[start + 1] === 0x4a ? 'image/jpeg' : bytes[start + 1] === 0x50 ? 'image/png' : 'image/jpeg';
      p = start + 4;
    } else {
      var mimeEnd = start + 1;
      while (mimeEnd < end && bytes[mimeEnd] !== 0) mimeEnd++;
      mime = clean(decodeSafe(decoders.latin1, bytes.subarray(start + 1, mimeEnd)));
      p = mimeEnd + 2; // skip description terminator + picture type
    }
    // skip the description string
    if (enc === 1 || enc === 2) {
      while (p + 1 < end && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < end && bytes[p] !== 0) p++;
      p += 1;
    }
    if (p >= end || end - p < 64) return null;
    return { mime: mime && mime.indexOf('/') > 0 ? mime : 'image/jpeg', bytes: bytes.slice(p, end) };
  }

  /* ---------- ID3v1 ---------- */

  function readId3v1(bytes) {
    if (bytes.length < 128) return null;
    var off = bytes.length - 128;
    if (bytes[off] !== 0x54 || bytes[off + 1] !== 0x41 || bytes[off + 2] !== 0x47) return null;
    var out = {
      title: clean(decodeSafe(decoders.latin1, bytes.subarray(off + 3, off + 33))),
      artist: clean(decodeSafe(decoders.latin1, bytes.subarray(off + 33, off + 63))),
      album: clean(decodeSafe(decoders.latin1, bytes.subarray(off + 63, off + 93)))
    };
    if (!out.title && !out.artist && !out.album) return null;
    return out;
  }

  /* ---------- MP4 / M4A ---------- */

  function findAtom(view, start, end, name) {
    var pos = start;
    while (pos + 8 <= end) {
      var size = view.getUint32(pos);
      var type = fourCC(view, pos + 4);
      var header = 8;
      if (size === 0) size = end - pos;
      else if (size === 1) {
        if (pos + 16 > end) break;
        var hi = view.getUint32(pos + 8);
        var lo = view.getUint32(pos + 12);
        size = hi * 4294967296 + lo;
        header = 16;
      }
      if (size < header || pos + size > end) break;
      if (type === name) return { start: pos + header, end: pos + size };
      pos += size;
    }
    return null;
  }

  function mp4Text(view, container, atomName) {
    var box = findAtom(view, container.start, container.end, atomName);
    if (!box) return '';
    var data = findAtom(view, box.start, box.end, 'data');
    if (!data) return '';
    return clean(decodeSafe(decoders.utf8, new Uint8Array(view.buffer, view.byteOffset + data.start + 8, Math.max(0, data.end - data.start - 8))));
  }

  function readMp4(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var moov = findAtom(view, 0, bytes.byteLength, 'moov');
    if (!moov) return null;
    var udta = findAtom(view, moov.start, moov.end, 'udta');
    if (!udta) return null;
    var meta = findAtom(view, udta.start, udta.end, 'meta');
    if (!meta) return null;
    var ilst = findAtom(view, meta.start + 4, meta.end, 'ilst');
    if (!ilst) return null;

    var out = {
      title: mp4Text(view, ilst, '\u00a9nam'),
      artist: mp4Text(view, ilst, '\u00a9ART') || mp4Text(view, ilst, 'aART'),
      album: mp4Text(view, ilst, '\u00a9alb')
    };

    var covr = findAtom(view, ilst.start, ilst.end, 'covr');
    if (covr) {
      var data = findAtom(view, covr.start, covr.end, 'data');
      if (data) {
        var type = view.getUint32(data.start + 1);
        var payload = bytes.slice(data.start + 8, data.end);
        if (payload.length > 64) {
          out.cover = { mime: type === 14 ? 'image/png' : 'image/jpeg', bytes: payload };
        }
      }
    }
    return out;
  }

  /* ---------- FLAC ---------- */

  function readFlac(bytes) {
    if (bytes.length < 8) return null;
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'fLaC') return null;

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 4;
    var out = {};

    while (pos + 4 <= bytes.length) {
      var header = bytes[pos];
      var isLast = (header & 0x80) !== 0;
      var type = header & 0x7f;
      var size = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      var body = pos + 4;
      var bodyEnd = body + size;
      if (bodyEnd > bytes.length) break;

      if (type === 4) readVorbisComment(view, bytes, body, bodyEnd, out);
      else if (type === 6) readFlacPicture(view, bytes, body, bodyEnd, out);

      pos = bodyEnd;
      if (isLast) break;
    }
    return out;
  }

  function readVorbisComment(view, bytes, start, end, out) {
    try {
      var pos = start;
      var vendorLen = view.getUint32(pos, true);
      pos += 4 + vendorLen;
      var count = view.getUint32(pos, true);
      pos += 4;
      for (var i = 0; i < count && pos + 4 <= end; i++) {
        var len = view.getUint32(pos, true);
        pos += 4;
        if (len < 0 || pos + len > end) break;
        var line = decodeSafe(decoders.utf8, bytes.subarray(pos, pos + len));
        pos += len;
        var eq = line.indexOf('=');
        if (eq < 1) continue;
        var key = line.slice(0, eq).toLowerCase();
        var value = clean(line.slice(eq + 1));
        if (!value) continue;
        if (key === 'title' && !out.title) out.title = value;
        else if (key === 'artist' && !out.artist) out.artist = value;
        else if (key === 'album' && !out.album) out.album = value;
        else if (key === 'albumartist' && !out.albumArtist) out.albumArtist = value;
      }
    } catch (err) { /* malformed comment block */ }
  }

  function readFlacPicture(view, bytes, start, end, out) {
    try {
      var pos = start + 4;
      var mimeLen = view.getUint32(pos); pos += 4;
      var mime = decodeSafe(decoders.latin1, bytes.subarray(pos, pos + mimeLen)); pos += mimeLen;
      var descLen = view.getUint32(pos); pos += 4 + descLen;
      pos += 16; // width, height, depth, colors
      var dataLen = view.getUint32(pos); pos += 4;
      if (dataLen <= 64 || pos + dataLen > end) return;
      out.cover = {
        mime: mime && mime.indexOf('/') > 0 ? mime : 'image/jpeg',
        bytes: bytes.slice(pos, pos + dataLen)
      };
    } catch (err) { /* malformed picture block */ }
  }

  /* ---------- filename fallback ---------- */

  function fromFileName(name) {
    var base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' ').trim();
    base = base.replace(/^\s*\d{1,3}[\s._-]+/, '');
    var m = base.split(/\s+-\s+/);
    if (m.length >= 2) {
      return { artist: clean(m[0]), title: clean(m.slice(1).join(' - ')) };
    }
    return { title: clean(base) };
  }

  /**
   * Read whatever metadata we can from a local audio file.
   * @param {File|Blob} file
   * @returns {Promise<{title?:string,artist?:string,album?:string,cover?:{mime:string,bytes:Uint8Array}}>}
   */
  async function read(file) {
    var tags = {};
    try {
      var head = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer());
      var id3 = readId3v2(head);
      if (id3) tags = Object.assign(tags, id3);
      if (!tags.title) {
        var mp4 = readMp4(head);
        if (mp4) tags = Object.assign(tags, prune(mp4));
      }
      if (!tags.title) {
        var flac = readFlac(bytesFromArrayBuffer(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer()));
        if (flac) tags = Object.assign(tags, flac);
      }
      if (!tags.title) {
        var tail = new Uint8Array(await file.slice(Math.max(0, file.size - 128), file.size).arrayBuffer());
        var v1 = readId3v1(tail);
        if (v1) tags = Object.assign(tags, v1);
      }
    } catch (err) {
      // Unreadable tags are fine: we fall back to the file name.
    }
    var fallback = fromFileName(file.name);
    return {
      title: clean(tags.title) || fallback.title || '未命名曲目',
      artist: clean(tags.artist) || fallback.artist || '未知歌手',
      album: clean(tags.album) || '',
      cover: tags.cover || null
    };
  }

  function bytesFromArrayBuffer(buffer) {
    return new Uint8Array(buffer);
  }

  function prune(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (key) {
      if (obj[key] && (!(obj[key] instanceof Uint8Array) || obj[key].length)) out[key] = obj[key];
    });
    return out;
  }

  global.MusicTags = { read: read, readSyncBuffer: readId3v2, fromFileName: fromFileName };
})(window);
