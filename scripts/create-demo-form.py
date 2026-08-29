from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "demo-form.pdf"
TEMP_DIR = ROOT / "tmp" / "pdfs"
BASE_PDF = TEMP_DIR / "formproof-demo-base.pdf"

PAGE_WIDTH, PAGE_HEIGHT = letter
NAVY = HexColor("#142C3E")
TEAL = HexColor("#0E9384")
TEAL_LIGHT = HexColor("#DDF4EF")
GOLD = HexColor("#E7B65A")
PAPER = HexColor("#F7F3E9")
WHITE = HexColor("#FFFFFF")
INK = HexColor("#24313D")
MUTED = HexColor("#65717D")
BORDER = HexColor("#C6D0D7")
SOFT = HexColor("#EDF1F2")

FIELD_NAMES = {
    "legal_name": "frm.q7f1",
    "email": "frm.p0x4",
    "contact": "frm.m2k9",
    "consent": "frm.c8v3",
    "housing": "frm.r4d6",
    "case_id": "frm.s1u2",
    "support": "frm.l9n5",
    "notes": "frm.t3w8",
    "witness": "frm.h6b0",
    "status": "frm.f2e4",
    "signature": "frm.z5a7",
}


def draw_page_shell(
    pdf: canvas.Canvas,
    page_number: int,
    title: str,
    subtitle: str,
    header_content_drop: float = 0,
) -> None:
    pdf.setFillColor(PAPER)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)

    pdf.setFillColor(NAVY)
    pdf.rect(0, 690, PAGE_WIDTH, 102, stroke=0, fill=1)
    pdf.setFillColor(TEAL)
    pdf.roundRect(52, 730 - header_content_drop, 34, 34, 9, stroke=0, fill=1)
    pdf.setFillColor(WHITE)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawCentredString(69, 741 - header_content_drop, "FP")

    pdf.setFont("Helvetica-Bold", 8)
    pdf.setFillColor(GOLD)
    pdf.drawString(102, 758 - header_content_drop, "FORMPROOF DEMONSTRATION")
    pdf.setFont("Helvetica-Bold", 20)
    pdf.setFillColor(WHITE)
    pdf.drawString(102, 732 - header_content_drop, title)
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(HexColor("#C9D4DA"))
    pdf.drawString(102, 714 - header_content_drop, subtitle)

    pdf.setFont("Helvetica-Bold", 8)
    pdf.setFillColor(TEAL_LIGHT)
    pdf.roundRect(488, 743 - header_content_drop, 70, 20, 10, stroke=0, fill=1)
    pdf.setFillColor(TEAL)
    pdf.drawCentredString(523, 750 - header_content_drop, "LOCAL ONLY")

    pdf.setStrokeColor(BORDER)
    pdf.line(52, 42, 560, 42)
    pdf.setFont("Helvetica", 7.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(52, 27, "Synthetic fixture - no real person or agency data")
    pdf.drawRightString(560, 27, f"FORMPROOF / {page_number} OF 2")


def draw_label(pdf: canvas.Canvas, label: str, x: float, y: float, required: bool = False) -> None:
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawString(x, y, label.upper())
    if required:
        width = pdf.stringWidth(label.upper(), "Helvetica-Bold", 8.5)
        pdf.setFillColor(TEAL)
        pdf.drawString(x + width + 4, y, "*")


def draw_info_card(pdf: canvas.Canvas, y: float, title: str, body: str) -> None:
    pdf.setFillColor(TEAL_LIGHT)
    pdf.roundRect(52, y, 508, 46, 9, stroke=0, fill=1)
    pdf.setFillColor(TEAL)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(66, y + 27, title.upper())
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica", 8.5)
    pdf.drawString(66, y + 12, body)


def add_text_field(
    pdf: canvas.Canvas,
    *,
    name: str,
    tooltip: str,
    x: float,
    y: float,
    width: float,
    height: float = 30,
    value: str = "",
    flags: str = "",
    max_length: int = 100,
    font_size: float = 10,
) -> None:
    pdf.acroForm.textfield(
        name=name,
        tooltip=tooltip,
        value=value,
        x=x,
        y=y,
        width=width,
        height=height,
        fillColor=WHITE,
        borderColor=BORDER,
        textColor=INK,
        borderWidth=1,
        borderStyle="solid",
        fieldFlags=flags,
        forceBorder=True,
        maxlen=max_length,
        fontName="Helvetica",
        fontSize=font_size,
    )


def create_base_pdf(path: Path) -> None:
    pdf = canvas.Canvas(str(path), pagesize=letter, pageCompression=1, invariant=1)
    pdf.setTitle("FormProof Synthetic AcroForm Demo")
    pdf.setAuthor("FormProof")
    pdf.setSubject("A deterministic two-page AcroForm fixture for local testing")

    draw_page_shell(
        pdf,
        1,
        "Residential support intake",
        "Page 1 - identity, contact, consent, and housing profile",
    )
    draw_info_card(
        pdf,
        628,
        "Privacy boundary",
        "This demo is processed in the browser. Field values do not leave the page.",
    )

    draw_label(pdf, "Legal name", 52, 600, required=True)
    add_text_field(
        pdf,
        name=FIELD_NAMES["legal_name"],
        tooltip="Legal name",
        x=52,
        y=560,
        width=508,
        flags="required",
        max_length=64,
    )

    draw_label(pdf, "Email address", 52, 526, required=True)
    add_text_field(
        pdf,
        name=FIELD_NAMES["email"],
        tooltip="Email address",
        x=52,
        y=486,
        width=322,
        flags="required",
        max_length=80,
    )

    draw_label(pdf, "Preferred contact", 394, 526, required=True)
    pdf.acroForm.choice(
        name=FIELD_NAMES["contact"],
        tooltip="Preferred contact method",
        value="Email",
        options=["Email", "Phone", "Text message"],
        x=394,
        y=486,
        width=166,
        height=30,
        fillColor=WHITE,
        borderColor=BORDER,
        textColor=INK,
        borderWidth=1,
        fieldFlags="required",
        forceBorder=True,
        fontName="Helvetica",
        fontSize=10,
    )

    pdf.setFillColor(WHITE)
    pdf.roundRect(52, 428, 508, 42, 8, stroke=0, fill=1)
    pdf.acroForm.checkbox(
        name=FIELD_NAMES["consent"],
        tooltip="Permission to contact about this request",
        checked=False,
        x=66,
        y=439,
        size=18,
        buttonStyle="check",
        fillColor=WHITE,
        borderColor=TEAL,
        textColor=TEAL,
        borderWidth=1,
        fieldFlags="required",
        forceBorder=True,
    )
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(96, 451, "I agree to be contacted about this synthetic request.")
    pdf.setFont("Helvetica", 7.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(96, 438, "Required before a review packet can be prepared.")

    pdf.setFillColor(WHITE)
    pdf.roundRect(52, 322, 508, 88, 9, stroke=0, fill=1)
    draw_label(pdf, "Current housing", 66, 390, required=True)
    housing_options = [
        ("rent", "Rent", 66),
        ("own", "Own", 226),
        ("other", "Other", 374),
    ]
    for value, label, x in housing_options:
        pdf.acroForm.radio(
            name=FIELD_NAMES["housing"],
            tooltip="Current housing arrangement",
            value=value,
            selected=False,
            x=x,
            y=346,
            size=18,
            buttonStyle="circle",
            fillColor=WHITE,
            borderColor=TEAL,
            textColor=TEAL,
            borderWidth=1,
            fieldFlags="noToggleToOff required radio",
            forceBorder=True,
        )
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica", 9)
        pdf.drawString(x + 27, 351, label)

    draw_label(pdf, "Case reference", 52, 286)
    add_text_field(
        pdf,
        name=FIELD_NAMES["case_id"],
        tooltip="Case reference (system maintained)",
        value="FP-DEMO-2042",
        x=52,
        y=246,
        width=248,
        flags="readOnly",
        max_length=24,
    )
    pdf.setFillColor(SOFT)
    pdf.roundRect(318, 246, 242, 30, 7, stroke=0, fill=1)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(332, 257, "Locked fields remain untouched by the agent.")

    pdf.setFillColor(NAVY)
    pdf.roundRect(52, 92, 508, 112, 12, stroke=0, fill=1)
    pdf.setFillColor(GOLD)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(70, 178, "FORMPROOF SAFETY MODEL")
    pdf.setFillColor(WHITE)
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawString(70, 152, "Draft first. Verify twice. Export once.")
    pdf.setFillColor(HexColor("#C9D4DA"))
    pdf.setFont("Helvetica", 8.5)
    pdf.drawString(70, 130, "Values are staged, reviewed by a person, and written to a fresh copy.")
    pdf.drawString(70, 114, "The source and output SHA-256 hashes bind the audit receipt to exact bytes.")
    pdf.showPage()

    draw_page_shell(
        pdf,
        2,
        "Support details and attestation",
        "Page 2 - requested services, review notes, and human-only controls",
        header_content_drop=16,
    )
    draw_info_card(
        pdf,
        628,
        "Human approval required",
        "Agent changes remain a draft until every flagged value is reviewed on screen.",
    )

    draw_label(pdf, "Requested support", 52, 600)
    pdf.acroForm.listbox(
        name=FIELD_NAMES["support"],
        tooltip="Requested support categories",
        value=["Rent assistance"],
        options=[
            "Rent assistance",
            "Utilities",
            "Food access",
            "Transportation",
        ],
        x=52,
        y=458,
        width=240,
        height=130,
        fillColor=WHITE,
        borderColor=BORDER,
        textColor=INK,
        borderWidth=1,
        fieldFlags="multiSelect",
        forceBorder=True,
        fontName="Helvetica",
        fontSize=9,
    )

    draw_label(pdf, "Context for reviewer", 312, 600)
    add_text_field(
        pdf,
        name=FIELD_NAMES["notes"],
        tooltip="Context for reviewer",
        x=312,
        y=458,
        width=248,
        height=130,
        flags="multiline",
        max_length=180,
        font_size=9,
    )

    pdf.setFillColor(WHITE)
    pdf.roundRect(52, 354, 508, 76, 9, stroke=0, fill=1)
    draw_label(pdf, "Witness initials", 66, 407)
    add_text_field(
        pdf,
        name=FIELD_NAMES["witness"],
        tooltip="[HUMAN_ONLY] Witness initials - complete during in-person review",
        x=66,
        y=368,
        width=174,
        height=27,
        max_length=4,
    )
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(260, 382, "Reserved for the in-person reviewer.")
    pdf.drawString(260, 369, "WebMCP cannot stage or approve this field.")

    draw_label(pdf, "Review status", 52, 326)
    add_text_field(
        pdf,
        name=FIELD_NAMES["status"],
        tooltip="Review status (system maintained)",
        value="AWAITING HUMAN REVIEW",
        x=52,
        y=286,
        width=248,
        flags="readOnly",
        max_length=32,
        font_size=9,
    )
    pdf.setFillColor(TEAL_LIGHT)
    pdf.roundRect(318, 286, 242, 30, 7, stroke=0, fill=1)
    pdf.setFillColor(TEAL)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(332, 297, "APPROVAL IS NEVER AN AGENT TOOL")

    pdf.setFillColor(WHITE)
    pdf.roundRect(52, 164, 508, 94, 10, stroke=0, fill=1)
    draw_label(pdf, "Applicant signature", 66, 236, required=True)
    pdf.setStrokeColor(BORDER)
    pdf.setLineWidth(1)
    pdf.roundRect(66, 180, 480, 42, 6, stroke=1, fill=0)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Oblique", 8)
    pdf.drawString(78, 196, "Sign in a trusted PDF reader after reviewing the exported values")
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(66, 150, "Blank signature widgets are detected and locked as human-only.")

    pdf.setFillColor(SOFT)
    pdf.roundRect(52, 72, 508, 56, 9, stroke=0, fill=1)
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(66, 104, "EXPORT RECEIPT")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(66, 88, "Source hash + plan hash + approval version + output hash")
    pdf.showPage()
    pdf.save()


def add_signature_widget(source: Path, destination: Path) -> None:
    reader = PdfReader(source)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)

    page = writer.pages[1]
    signature = DictionaryObject(
        {
            NameObject("/FT"): NameObject("/Sig"),
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/F"): NumberObject(4),
            NameObject("/Ff"): NumberObject(2),
            NameObject("/T"): TextStringObject(FIELD_NAMES["signature"]),
            NameObject("/TU"): TextStringObject(
                "[HUMAN_ONLY] Applicant signature - complete after final review"
            ),
            NameObject("/Rect"): ArrayObject(
                [
                    NumberObject(66),
                    NumberObject(180),
                    NumberObject(546),
                    NumberObject(222),
                ]
            ),
            NameObject("/P"): page.indirect_reference,
        }
    )
    signature_reference = writer._add_object(signature)

    annotations = page.get("/Annots")
    if annotations is None:
        annotations = ArrayObject()
        page[NameObject("/Annots")] = annotations
    else:
        annotations = annotations.get_object()
    annotations.append(signature_reference)

    acroform = writer.root_object["/AcroForm"].get_object()
    fields = acroform["/Fields"].get_object()
    fields.append(signature_reference)
    acroform[NameObject("/SigFlags")] = NumberObject(1)
    acroform[NameObject("/NeedAppearances")] = BooleanObject(False)

    writer.add_metadata(
        {
            "/Title": "FormProof Synthetic AcroForm Demo",
            "/Author": "FormProof",
            "/Subject": "Deterministic local-only form filling fixture",
        }
    )
    with destination.open("wb") as output_stream:
        writer.write(output_stream)


def widget_field_name(annotation: DictionaryObject) -> str | None:
    current = annotation
    while current is not None:
        name = current.get("/T")
        if name is not None:
            return str(name)
        parent = current.get("/Parent")
        current = parent.get_object() if parent is not None else None
    return None


def verify_output(path: Path) -> tuple[int, int]:
    reader = PdfReader(path)
    if len(reader.pages) != 2:
        raise RuntimeError(f"Expected 2 pages, found {len(reader.pages)}")

    fields = reader.get_fields() or {}
    expected_names = set(FIELD_NAMES.values())
    missing_fields = expected_names.difference(fields)
    if missing_fields:
        raise RuntimeError(f"Missing canonical fields: {sorted(missing_fields)}")

    widgets: list[tuple[int, str | None]] = []
    for page_number, page in enumerate(reader.pages, start=1):
        for annotation_reference in page.get("/Annots", []):
            annotation = annotation_reference.get_object()
            if annotation.get("/Subtype") == "/Widget":
                widgets.append((page_number, widget_field_name(annotation)))

    widget_names = {name for _, name in widgets if name is not None}
    missing_widgets = expected_names.difference(widget_names)
    if missing_widgets:
        raise RuntimeError(f"Missing page widgets: {sorted(missing_widgets)}")

    expected_types = {
        FIELD_NAMES["legal_name"]: "/Tx",
        FIELD_NAMES["email"]: "/Tx",
        FIELD_NAMES["contact"]: "/Ch",
        FIELD_NAMES["consent"]: "/Btn",
        FIELD_NAMES["housing"]: "/Btn",
        FIELD_NAMES["case_id"]: "/Tx",
        FIELD_NAMES["support"]: "/Ch",
        FIELD_NAMES["notes"]: "/Tx",
        FIELD_NAMES["witness"]: "/Tx",
        FIELD_NAMES["status"]: "/Tx",
        FIELD_NAMES["signature"]: "/Sig",
    }
    for name, expected_type in expected_types.items():
        actual_type = str(fields[name].get("/FT"))
        if actual_type != expected_type:
            raise RuntimeError(
                f"Field {name} has type {actual_type}; expected {expected_type}"
            )

    required = [
        FIELD_NAMES["legal_name"],
        FIELD_NAMES["email"],
        FIELD_NAMES["contact"],
        FIELD_NAMES["consent"],
        FIELD_NAMES["housing"],
        FIELD_NAMES["signature"],
    ]
    for name in required:
        if int(fields[name].get("/Ff", 0)) & 2 == 0:
            raise RuntimeError(f"Required flag missing from {name}")

    for name in [FIELD_NAMES["case_id"], FIELD_NAMES["status"]]:
        if int(fields[name].get("/Ff", 0)) & 1 == 0:
            raise RuntimeError(f"Read-only flag missing from {name}")

    human_tooltip = str(fields[FIELD_NAMES["witness"]].get("/TU", ""))
    if "[HUMAN_ONLY]" not in human_tooltip:
        raise RuntimeError("Human-only witness marker is missing")

    return len(fields), len(widgets)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    create_base_pdf(BASE_PDF)
    try:
        add_signature_widget(BASE_PDF, OUTPUT)
        field_count, widget_count = verify_output(OUTPUT)
    finally:
        BASE_PDF.unlink(missing_ok=True)

    print(
        f"Created {OUTPUT} with 2 pages, {field_count} canonical fields, "
        f"and {widget_count} page widgets."
    )


if __name__ == "__main__":
    main()
