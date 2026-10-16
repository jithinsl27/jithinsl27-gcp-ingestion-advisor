/* Data Cloud Compass - Google Workspace exports.
 *
 *  - xlsx(): a small Office Open XML writer (JSZip) that produces sheets with
 *    styles, images and native charts (bar / stacked bar / line / pie). Google
 *    Sheets converts the charts into Sheets charts on import.
 *  - svgToPng(): rasterises the architecture / roadmap SVG for Slides and Sheets.
 *  - driveUpload(): optional - uploads a file to the user's Google Drive and
 *    converts it to Google Sheets / Slides (OAuth, drive.file scope only).
 *
 * JSZip comes from the PptxGenJS bundle (static/vendor/pptxgen.bundle.js).
 */
(() => {
  "use strict";

  const X = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const colName = (i) => { let s = ""; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const ref = (sheet, c, r) => `'${sheet.replace(/'/g, "''")}'!$${colName(c)}$${r + 1}`;
  const rng = (sheet, c1, r1, c2, r2) => `${ref(sheet, c1, r1)}:$${colName(c2)}$${r2 + 1}`;

  // ---- styles: index used in cell objects as {v, s}
  const STYLE = { text: 0, head: 1, bold: 2, money: 3, moneyBold: 4, num: 5, wrap: 6, title: 7, price: 8, pct: 9, sub: 10 };
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="#,##0.00"/><numFmt numFmtId="166" formatCode="#,##0.0000"/><numFmt numFmtId="167" formatCode="0%"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="16"/><color rgb="FF1A73E8"/><name val="Arial"/></font><font><i/><sz val="9"/><color rgb="FF5F6368"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1A73E8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"><alignment vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function cellXml(cell, c, r) {
    if (cell === null || cell === undefined || cell === "") return "";
    const o = typeof cell === "object" ? cell : { v: cell };
    const a = `${colName(c)}${r + 1}`;
    const s = o.s !== undefined ? (typeof o.s === "number" ? o.s : STYLE[o.s] || 0) : 0;
    if (o.f) return `<c r="${a}" s="${s}"><f>${X(o.f)}</f></c>`;
    if (typeof o.v === "number" && Number.isFinite(o.v)) return `<c r="${a}" s="${s}"><v>${o.v}</v></c>`;
    return `<c r="${a}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${X(o.v)}</t></is></c>`;
  }

  const PALETTE = ["1A73E8", "188038", "F9AB00", "D93025", "9334E6", "12A4AF", "E52592", "5F6368", "E37400", "4285F4"];

  function chartXml(ch, sheetName, data) {
    // ch: {type: "bar"|"stacked"|"line"|"pie", title, catCol, firstRow, lastRow, series: [{col, color}], horizontal}
    const cats = data.slice(ch.firstRow, ch.lastRow + 1).map((row) => String(row[ch.catCol]?.v ?? row[ch.catCol] ?? ""));
    const val = (row, col) => { const c = row[col]; const v = c && typeof c === "object" ? c.v : c; return typeof v === "number" ? v : 0; };
    const ser = ch.series.map((s, i) => {
      const head = data[ch.firstRow - 1]?.[s.col];
      const name = String(head && typeof head === "object" ? head.v : head ?? `Series ${i + 1}`);
      const vals = data.slice(ch.firstRow, ch.lastRow + 1).map((row) => val(row, s.col));
      const color = s.color || PALETTE[i % PALETTE.length];
      const sp = ch.type === "line"
        ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${s.dash ? '<a:prstDash val="dash"/>' : ""}</a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
        : ch.type === "pie" ? "" : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
      const dpts = ch.type === "pie" ? cats.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${(ch.colors && ch.colors[k]) || PALETTE[k % PALETTE.length]}"/></a:solidFill></c:spPr></c:dPt>`).join("") : "";
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>
        <c:tx><c:strRef><c:f>${ref(sheetName, s.col, ch.firstRow - 1)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${X(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
        ${sp}${dpts}${ch.type === "line" ? "" : ""}
        <c:cat><c:strRef><c:f>${rng(sheetName, ch.catCol, ch.firstRow, ch.catCol, ch.lastRow)}</c:f><c:strCache><c:ptCount val="${cats.length}"/>${cats.map((c2, k) => `<c:pt idx="${k}"><c:v>${X(c2)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:f>${rng(sheetName, s.col, ch.firstRow, s.col, ch.lastRow)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, k) => `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val>
        ${ch.type === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
    }).join("");
    const axes = `<c:catAx><c:axId val="500001"/><c:scaling><c:orientation val="${ch.horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${ch.horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
      <c:valAx><c:axId val="500002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${ch.horizontal ? "b" : "l"}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="DADCE0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
    let plot;
    if (ch.type === "pie") plot = `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
    else if (ch.type === "line") plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="500001"/><c:axId val="500002"/></c:lineChart>${axes}`;
    else plot = `<c:barChart><c:barDir val="${ch.horizontal ? "bar" : "col"}"/><c:grouping val="${ch.type === "stacked" ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/>${ch.type === "stacked" ? '<c:overlap val="100"/>' : ""}<c:axId val="500001"/><c:axId val="500002"/></c:barChart>${axes}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:roundedCorners val="0"/>
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1"/><a:t>${X(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>
<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>
</c:chartSpace>`;
  }

  const anchorXml = (a, inner, editAs) => `<xdr:twoCellAnchor${editAs ? ` editAs="${editAs}"` : ""}><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${a.col + a.cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row + a.rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${inner}<xdr:clientData/></xdr:twoCellAnchor>`;

  /**
   * sheets: [{ name, rows: [[cell]], widths: [chars], freeze: rowCount, merges: ["A1:F1"],
   *            charts: [{ ...chart, anchor: {col,row,cols,rows} }], images: [{ png: Uint8Array, anchor }] }]
   */
  async function xlsx(sheets) {
    if (!window.JSZip) throw new Error("Spreadsheet library not loaded");
    const zip = new window.JSZip();
    const ct = [];
    let chartN = 0, drawN = 0, imgN = 0;
    const wbRels = [];
    sheets.forEach((sh, si) => {
      const name = sh.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " ");
      sh._name = name;
      const rows = sh.rows;
      const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
      const view = sh.freeze ? `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}/></sheetViews>`;
      const data = rows.map((row, r) => `<row r="${r + 1}"${row && row._h ? ` ht="${row._h}" customHeight="1"` : ""}>${(row || []).map((cell, c) => cellXml(cell, c, r)).join("")}</row>`).join("");
      const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
      let drawing = "";
      if ((sh.charts && sh.charts.length) || (sh.images && sh.images.length)) {
        drawN++;
        const dRels = [];
        let anchors = "";
        let shapeId = 1;
        (sh.charts || []).forEach((ch) => {
          chartN++;
          const rid = `rId${dRels.length + 1}`;
          dRels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartN}.xml"/>`);
          zip.file(`xl/charts/chart${chartN}.xml`, chartXml(ch, name, rows));
          ct.push(`<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
          shapeId++;
          anchors += anchorXml(ch.anchor, `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="Chart ${shapeId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
            <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame>`);
        });
        (sh.images || []).forEach((im) => {
          imgN++;
          const rid = `rId${dRels.length + 1}`;
          dRels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imgN}.png"/>`);
          zip.file(`xl/media/image${imgN}.png`, im.png);
          shapeId++;
          anchors += anchorXml(im.anchor, `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="${X(im.name || "Image")}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
            <xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
            <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`, "oneCell");
        });
        zip.file(`xl/drawings/drawing${drawN}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`);
        zip.file(`xl/drawings/_rels/drawing${drawN}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${dRels.join("")}</Relationships>`);
        ct.push(`<Override PartName="/xl/drawings/drawing${drawN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
        zip.file(`xl/worksheets/_rels/sheet${si + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawN}.xml"/></Relationships>`);
        drawing = `<drawing r:id="rId1"/>`;
      }
      zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>${merges}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>${drawing}</worksheet>`);
      ct.push(`<Override PartName="/xl/worksheets/sheet${si + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      wbRels.push(`<Relationship Id="rId${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
    });
    wbRels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews>
<sheets>${sheets.map((sh, i) => `<sheet name="${X(sh._name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join("")}</Relationships>`);
    zip.file("xl/styles.xml", STYLES_XML);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${ct.join("")}</Types>`);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", compression: "DEFLATE" });
  }

  // ---- SVG -> PNG
  function svgToPng(svgText, width, scale = 2) {
    return new Promise((resolve, reject) => {
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgText);
      const w0 = vb ? +vb[1] : width || 1200, h0 = vb ? +vb[2] : 600;
      const w = Math.round((width || w0) * scale), h = Math.round(((width || w0) * h0 / w0) * scale);
      const svg = svgText.replace(/<\?xml[^>]*>\s*/, "").replace("<svg ", `<svg width="${w}" height="${h}" `);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d");
        g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/png");
        const bin = atob(dataUrl.split(",")[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve({ dataUrl, bytes, w: w / scale, h: h / scale });
      };
      img.onerror = () => reject(new Error("Could not render the diagram image"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  // ---- Google Drive (optional, needs an OAuth client ID)
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Could not load Google sign-in"));
      document.head.appendChild(s);
    });
  }
  let token = null, tokenExp = 0;
  async function accessToken(clientId) {
    if (token && Date.now() < tokenExp - 60000) return token;
    await loadScript("https://accounts.google.com/gsi/client");
    return new Promise((resolve, reject) => {
      const tc = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          token = resp.access_token; tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          resolve(token);
        },
        error_callback: (err) => reject(new Error(err?.message || "Google sign-in was cancelled")),
      });
      tc.requestAccessToken();
    });
  }
  const GOOGLE_MIME = { sheets: "application/vnd.google-apps.spreadsheet", slides: "application/vnd.google-apps.presentation", docs: "application/vnd.google-apps.document" };
  async function driveUpload(blob, name, kind, clientId) {
    const t = await accessToken(clientId);
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name, mimeType: GOOGLE_MIME[kind] })], { type: "application/json" }));
    form.append("file", blob);
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
      method: "POST", headers: { Authorization: "Bearer " + t }, body: form,
    });
    if (!r.ok) throw new Error(`Google Drive upload failed (${r.status})`);
    return r.json();
  }

  window.CompassExports = {
    xlsx, svgToPng, driveUpload, STYLE,
    ready: () => !!(window.JSZip && window.PptxGenJS),
  };
})();
