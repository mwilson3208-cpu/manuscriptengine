"""Build packages/export/assets/reference-6x9.docx from Pandoc's default reference docx.

Run once, or again after changing a value below:
    pandoc --print-default-data-file reference.docx > /tmp/default-ref.docx
    python3 packages/export/tools/make-reference-docx.py /tmp/default-ref.docx packages/export/assets/reference-6x9.docx

Sets a 6 x 9 inch page with mirrored margins, Garamond 11 point at 1.15 line
spacing for body text, and a page break before every level 1 heading. The DOCX
is the archive master and the Phase 0 reading copy; print layout is the PDF
renderer's job in Phase 3.
"""
import re
import sys
import zipfile

TWIP = 1440  # twips per inch
PAGE_W, PAGE_H = 6 * TWIP, 9 * TWIP
INSIDE, OUTSIDE, TOP, BOTTOM = int(0.625 * TWIP), int(0.5 * TWIP), int(0.5 * TWIP), int(0.5 * TWIP)
FONT = "Garamond"
SIZE_HALF_POINTS = 22  # 11 pt
LINE_240THS = 276  # 1.15 lines


def patch_document(xml: str) -> str:
    sect = (
        f'<w:sectPr><w:pgSz w:w="{PAGE_W}" w:h="{PAGE_H}"/>'
        f'<w:pgMar w:top="{TOP}" w:right="{OUTSIDE}" w:bottom="{BOTTOM}" w:left="{INSIDE}" '
        f'w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>'
    )
    out, n = re.subn(r"<w:sectPr\s*/>|<w:sectPr>.*?</w:sectPr>", sect, xml, flags=re.S)
    if n == 0:
        raise SystemExit("no sectPr found in document.xml")
    return out


def patch_styles(xml: str) -> str:
    xml = re.sub(
        r"<w:rFonts [^>]*/>",
        f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsiaTheme="minorHAnsi" w:cs="{FONT}" />',
        xml,
        count=1,
    )
    xml = xml.replace('<w:sz w:val="24" />', f'<w:sz w:val="{SIZE_HALF_POINTS}" />', 1)
    xml = xml.replace('<w:szCs w:val="24" />', f'<w:szCs w:val="{SIZE_HALF_POINTS}" />', 1)
    xml = xml.replace(
        '<w:spacing w:after="200" />',
        f'<w:spacing w:after="120" w:line="{LINE_240THS}" w:lineRule="auto" />',
        1,
    )

    def heading1(m: re.Match) -> str:
        block = m.group(0)
        if "<w:pageBreakBefore" in block:
            return block
        return block.replace("<w:pPr>", "<w:pPr><w:pageBreakBefore />", 1)

    xml = re.sub(r'<w:style w:type="paragraph" w:styleId="Heading1">.*?</w:style>', heading1, xml, count=1, flags=re.S)
    return xml


def patch_settings(xml: str) -> str:
    if "<w:mirrorMargins" in xml:
        return xml
    return re.sub(r"(<w:settings[^>]*>)", r"\1<w:mirrorMargins />", xml, count=1)


def main(src: str, dst: str) -> None:
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                data = patch_document(data.decode("utf8")).encode("utf8")
            elif item.filename == "word/styles.xml":
                data = patch_styles(data.decode("utf8")).encode("utf8")
            elif item.filename == "word/settings.xml":
                data = patch_settings(data.decode("utf8")).encode("utf8")
            zout.writestr(item, data)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
