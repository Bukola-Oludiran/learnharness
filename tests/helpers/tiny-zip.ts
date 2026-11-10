/** A minimal zip WRITER for fixtures (fork): deflated or stored entries, no
 *  data descriptors — the shape Office files use. Tests build decks from it. */
import { deflateRawSync } from "node:zlib";

/** CRC is not checked by the reader under test; zero keeps the fixture small. */
export function tinyZip(files: Record<string, string | Uint8Array>, options: { store?: boolean } = {}): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const raw = Buffer.from(content);
		const data = options.store ? raw : deflateRawSync(raw);
		const nameBytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(options.store ? 0 : 8, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(options.store ? 0 : 8, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const slideXml = (paragraphs: string[]) =>
	`<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`;

export interface TinySlide {
	paragraphs: string[];
	notes?: string[];
	/** Media file names under ppt/media/ this slide shows. */
	pictures?: string[];
}

/** A deck whose presentation order is `order` (1-based slide file numbers;
 *  defaults to file order). `media` supplies the picture bytes. */
export function tinyDeck(slides: TinySlide[], media: Record<string, Uint8Array> = {}, order?: number[]): Buffer {
	const files: Record<string, string | Uint8Array> = {};
	const sequence = order ?? slides.map((_, i) => i + 1);
	files["ppt/presentation.xml"] = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${sequence.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join("")}</p:sldIdLst></p:presentation>`;
	files["ppt/_rels/presentation.xml.rels"] = `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`;
	slides.forEach((slide, i) => {
		const n = i + 1;
		files[`ppt/slides/slide${n}.xml`] = slideXml(slide.paragraphs);
		const rels: string[] = [];
		if (slide.notes) {
			files[`ppt/notesSlides/notesSlide${n}.xml`] = slideXml([...slide.notes, String(n)]);
			rels.push(`<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
		}
		(slide.pictures ?? []).forEach((picture, p) => rels.push(`<Relationship Id="rIdP${p}" Type="${REL}/image" Target="../media/${picture}"/>`));
		if (rels.length > 0) files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<Relationships>${rels.join("")}</Relationships>`;
	});
	for (const [name, bytes] of Object.entries(media)) files[`ppt/media/${name}`] = bytes;
	return tinyZip(files);
}
