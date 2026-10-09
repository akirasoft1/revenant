"""Test-only LZ-string ``compressToEncodedURIComponent`` (port of
pieroxy/lz-string 1.5, MIT) -- builds synthetic spviewer exports. Pinned
against the JS library's output in test_spviewer.py."""
_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$"


def compress_to_encoded_uri_component(text: str) -> str:
    raw = text.encode("utf-16-le", "surrogatepass")
    units = [chr(raw[i] | (raw[i + 1] << 8)) for i in range(0, len(raw), 2)]
    bits_per_char = 6
    dictionary: dict[str, int] = {}
    to_create: set[str] = set()
    w = ""
    enlarge_in, dict_size, num_bits = 2, 3, 2
    data: list[str] = []
    val, pos = 0, 0

    def write(bit: int) -> None:
        nonlocal val, pos
        val = (val << 1) | bit
        if pos == bits_per_char - 1:
            pos = 0
            data.append(_KEY[val])
            val = 0
        else:
            pos += 1

    def write_value(value: int, n: int) -> None:
        for _ in range(n):
            write(value & 1)
            value >>= 1

    def bump() -> None:
        nonlocal enlarge_in, num_bits
        enlarge_in -= 1
        if enlarge_in == 0:
            enlarge_in = 2 ** num_bits
            num_bits += 1

    def emit_w() -> None:
        if w in to_create:
            code = ord(w[0])
            if code < 256:
                write_value(0, num_bits)
                write_value(code, 8)
            else:
                write_value(1, num_bits)
                write_value(code, 16)
            bump()
            to_create.discard(w)
        else:
            write_value(dictionary[w], num_bits)

    for c in units:
        if c not in dictionary:
            dictionary[c] = dict_size
            dict_size += 1
            to_create.add(c)
        wc = w + c
        if wc in dictionary:
            w = wc
        else:
            emit_w()
            bump()
            dictionary[wc] = dict_size
            dict_size += 1
            w = c
    if w != "":
        emit_w()
        bump()
    write_value(2, num_bits)
    while True:
        val <<= 1
        if pos == bits_per_char - 1:
            data.append(_KEY[val])
            break
        pos += 1
    return "".join(data)
