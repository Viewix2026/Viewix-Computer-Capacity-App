// docx + file-saver are loaded lazily — they only matter when a
// producer hits "Export DOCX" and they're huge (docx alone is ~300 KB
// minified). Module-level `let`s get populated by ensureDocxLoaded()
// the first time the export runs, so the rest of the file's code
// keeps using the same symbol names.
let Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun;
let Header, AlignmentType, LevelFormat, BorderStyle, WidthType, ShadingType;
let HeadingLevel, PageBreak, saveAs;

async function ensureDocxLoaded() {
  if (Document) return;
  const [docx, fs] = await Promise.all([
    import("docx"),
    import("file-saver"),
  ]);
  ({ Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
     Header, AlignmentType, LevelFormat, BorderStyle, WidthType, ShadingType,
     HeadingLevel, PageBreak } = docx);
  saveAs = fs.saveAs || fs.default?.saveAs || fs.default;
  border = { style: BorderStyle.SINGLE, size: 1, color: BORDER_GREY };
  borders = { top: border, bottom: border, left: border, right: border };
  noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
  noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
}

// ─── Brand colours ───
const ORANGE = "F27A1A";
const BLUE = "2C8DFF";
const DARK = "1A1D23";
const GREY = "5A6B85";
const LIGHT_GREY = "F0F2F5";
const BORDER_GREY = "D1D5DB";
const WHITE = "FFFFFF";

// border / borders / noBorder / noBorders depend on BorderStyle from
// docx (lazy-loaded), so they're populated by ensureDocxLoaded() too.
let border, borders, noBorder, noBorders;
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

// Content width for A4 portrait with 1" margins = 9026 DXA
const PAGE_W = 11906;
const MARGIN = 1440;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ─── Helpers ───
function headerCell(text, width) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA }, margins: cellMargins,
    shading: { fill: DARK, type: ShadingType.CLEAR },
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, font: "Arial", size: 18, color: WHITE })] })],
  });
}
function bodyCell(text, width, opts = {}) {
  const runs = Array.isArray(text)
    ? text.map(t => typeof t === "string" ? new TextRun({ text: t, font: "Arial", size: 18, color: DARK }) : t)
    : [new TextRun({ text: text || "", font: "Arial", size: 18, color: DARK, ...(opts.bold ? { bold: true } : {}), ...(opts.italic ? { italics: true } : {}) })];
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA }, margins: cellMargins,
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ children: runs })],
  });
}
function infoPair(label, value) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, font: "Arial", size: 20, color: DARK }),
      new TextRun({ text: value || "—", font: "Arial", size: 20, color: GREY }),
    ],
  });
}

async function fetchImageBuffer(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch { return null; }
}

// ─── Main export function ───
export async function generateRunsheetDocx(runsheet, producer, director, clientLogoUrl) {
  // Lazy-load the heavy docx + file-saver libs on first use. Initial
  // dashboard load doesn't pay the ~300 KB cost.
  await ensureDocxLoaded();
  // Load logos
  let viewixLogoData = null;
  try {
    const resp = await fetch("/viewix-logo.png");
    if (resp.ok) viewixLogoData = await resp.arrayBuffer();
  } catch {}

  let clientLogoData = null;
  if (clientLogoUrl) clientLogoData = await fetchImageBuffer(clientLogoUrl);

  // ─── Build logo header row ───
  const logoChildren = [];
  const logoCells = [];
  if (viewixLogoData) {
    logoCells.push(new TableCell({
      borders: noBorders, width: { size: Math.floor(CONTENT_W / 2), type: WidthType.DXA },
      children: [new Paragraph({
        children: [new ImageRun({
          type: "png", data: viewixLogoData,
          transformation: { width: 140, height: 37 },
          altText: { title: "Viewix", description: "Viewix Logo", name: "ViewixLogo" },
        })],
      })],
    }));
  } else {
    logoCells.push(new TableCell({
      borders: noBorders, width: { size: Math.floor(CONTENT_W / 2), type: WidthType.DXA },
      children: [new Paragraph({ children: [new TextRun({ text: "Viewix", bold: true, font: "Arial", size: 28, color: BLUE })] })],
    }));
  }
  if (clientLogoData) {
    logoCells.push(new TableCell({
      borders: noBorders, width: { size: Math.floor(CONTENT_W / 2), type: WidthType.DXA },
      children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new ImageRun({
          type: "png", data: clientLogoData,
          transformation: { width: 120, height: 40 },
          altText: { title: "Client", description: "Client Logo", name: "ClientLogo" },
        })],
      })],
    }));
  } else {
    logoCells.push(new TableCell({
      borders: noBorders, width: { size: Math.floor(CONTENT_W / 2), type: WidthType.DXA },
      children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: runsheet.companyName || "", bold: true, font: "Arial", size: 24, color: DARK })],
      })],
    }));
  }
  if (logoCells.length) {
    logoChildren.push(new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [Math.floor(CONTENT_W / 2), Math.floor(CONTENT_W / 2)],
      rows: [new TableRow({ children: logoCells })],
    }));
    logoChildren.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
  }

  // ─── Info section ───
  const infoChildren = [];
  const firstDay = (runsheet.shootDays || [])[0];
  if (firstDay?.date) {
    const d = new Date(firstDay.date + "T00:00:00");
    infoChildren.push(infoPair("Date", d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })));
  }
  if (firstDay?.location) infoChildren.push(infoPair("Location", firstDay.location));
  if (director) infoChildren.push(infoPair("Shooter", `${director.name}${director.phone ? " - " + director.phone : ""}`));
  if (producer) infoChildren.push(infoPair("Producer", `${producer.name}${producer.phone ? " - " + producer.phone : ""}`));
  (runsheet.clientContacts || []).forEach(c => {
    infoChildren.push(infoPair(c.name || "Client", c.phone || ""));
  });
  infoChildren.push(new Paragraph({ spacing: { after: 200 }, children: [] }));

  // ─── Scene type labels for Meta Ads ───
  const SCENE_LABELS = {
    hook: "Hook", explainThePain: "Explain the Pain", results: "Results",
    theOffer: "The Offer", whyTheOffer: "Why the Offer", cta: "CTA",
  };
  const isMetaAds = runsheet.projectType === "metaAds";

  // ─── Schedule tables per shoot day ───
  const scheduleChildren = [];
  let grandTotalVideos = 0;

  (runsheet.shootDays || []).forEach((day, dayIdx) => {
    // Shoot heading
    const dateStr = day.date
      ? new Date(day.date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })
      : "";
    scheduleChildren.push(new Paragraph({
      spacing: { before: dayIdx > 0 ? 300 : 0, after: 120 },
      children: [new TextRun({
        text: `${day.label || "Shoot " + (dayIdx + 1)}${dateStr ? " — " + dateStr : ""}${day.location ? " — " + day.location : ""}`,
        bold: true, font: "Arial", size: 24, color: DARK,
      })],
    }));

    let colW, colHeaders;
    if (isMetaAds) {
      // Meta Ads: Time | Scene Elements | Location | Props | People | #
      colW = [1200, 3400, 1300, 1300, 1000, 826];
      colHeaders = ["Time", "Scene Elements", "Location", "Props", "People", "#"];
    } else {
      // Organic: Time | Videos | Location | Props | People | #
      colW = [1400, 2600, 1500, 1500, 1200, 826];
      colHeaders = ["Time", "Videos", "Location", "Props", "People", "#"];
    }
    const tableRows = [
      new TableRow({ children: colHeaders.map((h, i) => headerCell(h, colW[i])) }),
    ];

    let dayVideoCount = 0;
    (day.timeSlots || []).forEach(slot => {
      const slotElements = slot.sceneElements || [];
      const slotVideos = (slot.videoIds || []).map(vid => (runsheet.videos || []).find(v => v.id === vid)).filter(Boolean);
      const isBreak = slot.notes?.includes("Break") && !slotVideos.length && !slotElements.length;
      const breakStyle = { italic: true, shading: "FEF3C7" };
      const timeStr = `${slot.startTime || ""} - ${slot.endTime || ""}`;

      if (isMetaAds) {
        // Group scene elements by scene type for readable display
        const grouped = {};
        slotElements.forEach(el => {
          const v = (runsheet.videos || []).find(x => x.id === el.videoId);
          if (!v) return;
          if (!grouped[el.sceneType]) grouped[el.sceneType] = [];
          grouped[el.sceneType].push(v.videoName);
        });
        const sceneLines = Object.entries(grouped)
          .map(([sceneKey, names]) => `${SCENE_LABELS[sceneKey] || sceneKey}: ${names.join(", ")}`)
          .join("\n");
        const displayText = isBreak ? slot.notes : sceneLines;
        const count = slotElements.length;
        dayVideoCount += count;
        tableRows.push(new TableRow({
          children: [
            bodyCell(timeStr, colW[0], isBreak ? breakStyle : {}),
            bodyCell(displayText, colW[1], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : (slot.location || day.location || ""), colW[2], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : (slot.props || ""), colW[3], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : (slot.people || ""), colW[4], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : String(count || ""), colW[5], isBreak ? breakStyle : {}),
          ],
        }));
      } else {
        const videoCount = slotVideos.length;
        dayVideoCount += videoCount;
        const videoNames = isBreak ? slot.notes : slotVideos.map(v => v.videoName).join("\n");
        tableRows.push(new TableRow({
          children: [
            bodyCell(timeStr, colW[0], isBreak ? breakStyle : {}),
            bodyCell(videoNames, colW[1], isBreak ? breakStyle : { bold: true }),
            bodyCell(isBreak ? "" : (slot.location || day.location || ""), colW[2], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : (slot.props || ""), colW[3], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : (slot.people || ""), colW[4], isBreak ? breakStyle : {}),
            bodyCell(isBreak ? "" : String(videoCount || ""), colW[5], isBreak ? breakStyle : {}),
          ],
        }));
      }
    });

    grandTotalVideos += dayVideoCount;

    // Total row
    const totalCells = colW.map((w, i) => {
      if (i === colW.length - 2) return bodyCell("Total:", w, { bold: true });
      if (i === colW.length - 1) return bodyCell(String(dayVideoCount), w, { bold: true });
      return bodyCell("", w);
    });
    tableRows.push(new TableRow({ children: totalCells }));

    scheduleChildren.push(new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: colW,
      rows: tableRows,
    }));
    scheduleChildren.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
  });

  // ─── Video breakdowns ───
  const breakdownChildren = [];
  const videosWithDetails = (runsheet.videos || []).filter(v => v.contentStyle || v.hook || v.props || v.people);
  if (videosWithDetails.length > 0) {
    breakdownChildren.push(new Paragraph({ children: [new PageBreak()] }));
    breakdownChildren.push(new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: "Video Breakdown", bold: true, font: "Arial", size: 28, color: DARK })],
    }));

    const bdColW = [1200, 1600, 2200, 2200, 1826];
    breakdownChildren.push(new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: bdColW,
      rows: [
        new TableRow({
          children: ["#", "Video", "Hook", "Description", "Props"].map((h, i) => headerCell(h, bdColW[i])),
        }),
        ...videosWithDetails.map((v, i) =>
          new TableRow({
            children: [
              bodyCell(String(i + 1), bdColW[0]),
              bodyCell(v.videoName || "", bdColW[1], { bold: true }),
              bodyCell(v.hook || "", bdColW[2]),
              bodyCell(v.contentStyle || v.explainThePain || "", bdColW[3]),
              bodyCell(v.props || "", bdColW[4]),
            ],
          })
        ),
      ],
    }));
  }

  // ─── Grand total ───
  const totalChildren = [
    new Paragraph({ spacing: { before: 300 }, children: [] }),
    new Paragraph({
      children: [
        new TextRun({ text: "Total Videos: ", bold: true, font: "Arial", size: 24, color: DARK }),
        new TextRun({ text: String(grandTotalVideos), bold: true, font: "Arial", size: 28, color: BLUE }),
      ],
    }),
  ];

  // ─── Assemble document ───
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Arial", size: 20 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Arial", color: DARK },
          paragraph: { spacing: { before: 240, after: 120 } } },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: 16838 },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      children: [
        ...logoChildren,
        ...infoChildren,
        ...scheduleChildren,
        ...breakdownChildren,
        ...totalChildren,
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${runsheet.companyName || "Runsheet"} - Runsheet.docx`);
}
