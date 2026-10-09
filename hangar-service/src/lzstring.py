"""LZ-string ``decompressFromEncodedURIComponent`` (vendored, decode only).

A direct port of the reference JavaScript (pieroxy/lz-string 1.5, MIT,
https://github.com/pieroxy/lz-string). spviewer.eu stores saved loadouts with
``LZString.compressToEncodedURIComponent(JSON.stringify(loadout))``.

Why vendored: the PyPI ``lzstring`` package is unmaintained (last release
2016, depends on the Python-2 ``future`` shim) and has no output cap. This
port adds the two things an upload endpoint needs:

- ``max_chars``: decoding stops with ``LZStringError`` once the output would
  exceed the cap (decompression-bomb guard -- the dictionary only grows with
  the output, so memory is bounded by the cap too);
- strictness: a character outside the URI-safe alphabet, a truncated stream or
  an invalid back-reference raises ``LZStringError`` instead of the JS
  library's silent ``""``/``null``.

JS strings are UTF-16 code units, so a non-BMP character arrives as two
surrogate code units; they are re-joined at the end.
"""

_KEY_URI_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$"
_REVERSE = {c: i for i, c in enumerate(_KEY_URI_SAFE)}


class LZStringError(ValueError):
    """The input is not a valid (or is an over-sized) LZ-string stream."""


def decompress_from_encoded_uri_component(data: str, *, max_chars: int | None = None) -> str:
    if not isinstance(data, str):
        raise LZStringError("input is not a string")
    if data == "":
        return ""
    data = data.replace(" ", "+")   # '+' can arrive URL-decoded as a space
    try:
        values = [_REVERSE[c] for c in data]
    except KeyError as e:
        raise LZStringError(f"character {e.args[0]!r} is not in the LZ-string URI-safe alphabet") from None
    return _decompress(values, 32, max_chars)


def _decompress(values: list[int], reset_value: int, max_chars: int | None) -> str:
    length = len(values)
    dictionary: list[str] = ["", "", ""]   # codes 0..2 are control codes
    enlarge_in = 4
    num_bits = 3
    val = values[0]
    position = reset_value
    index = 1
    out: list[str] = []
    total = 0

    def read(n: int) -> int:
        nonlocal val, position, index
        bits, power = 0, 1
        maxpower = 1 << n
        while power != maxpower:
            resb = val & position
            position >>= 1
            if position == 0:
                position = reset_value
                val = values[index] if index < length else 0
                index += 1
            if resb:
                bits |= power
            power <<= 1
        return bits

    first = read(2)
    if first == 0:
        c = chr(read(8))
    elif first == 1:
        c = chr(read(16))
    elif first == 2:
        return ""
    else:
        raise LZStringError(f"invalid first code {first}")
    dictionary.append(c)            # code 3
    w = c
    out.append(c)
    total = 1

    while True:
        if index > length:
            raise LZStringError("truncated LZ-string stream (no end marker)")
        code = read(num_bits)
        if code == 0 or code == 1:
            dictionary.append(chr(read(8 if code == 0 else 16)))
            code = len(dictionary) - 1
            enlarge_in -= 1
        elif code == 2:
            text = "".join(out)
            return _join_surrogates(text)
        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1
        if code < len(dictionary) and code > 2:
            entry = dictionary[code]
        elif code == len(dictionary):
            entry = w + w[0]
        else:
            raise LZStringError(f"invalid back-reference {code}")
        total += len(entry)
        if max_chars is not None and total > max_chars:
            raise LZStringError(f"decompressed data exceeds {max_chars} characters")
        out.append(entry)
        dictionary.append(w + entry[0])
        enlarge_in -= 1
        w = entry
        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1


def _join_surrogates(text: str) -> str:
    if not any("\ud800" <= ch <= "\udfff" for ch in text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
