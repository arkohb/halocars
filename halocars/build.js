#!/usr/bin/env node
/**
 * HALO AUTOS — build step
 * Scans /cars, resizes photos, generates dist/data/inventory.json.
 * Only dependency is sharp (for image resizing). If sharp is missing,
 * the build still works — it just copies photos through untouched.
 *
 * Drop a folder into /cars, push to GitHub, Netlify rebuilds. That's the whole flow.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CARS_DIR = path.join(ROOT, 'cars');
const SRC_DIR = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.imgcache');

/** Rendered widths. Browser picks the smallest one that fills the slot. */
const WIDTHS = [480, 960, 1600];
const QUALITY = 76;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const MAKES = ['Toyota', 'Honda', 'Nissan', 'Hyundai', 'Kia', 'Mercedes-Benz', 'Mercedes', 'BMW', 'Audi',
  'Volkswagen', 'Ford', 'Chevrolet', 'Mazda', 'Mitsubishi', 'Lexus', 'Land Rover', 'Range Rover',
  'Jeep', 'Suzuki', 'Peugeot', 'Renault', 'Subaru', 'Infiniti', 'Acura', 'Volvo', 'Porsche', 'Tesla',
  'Chery', 'Changan', 'Haval', 'Geely', 'BYD', 'Isuzu', 'Daf', 'Scania', 'Man'];

let sharp = null;
try { sharp = require('sharp'); }
catch { console.warn('  ! sharp not installed — photos will be copied at full size. Run: npm install'); }

const stats = { made: 0, cached: 0, copied: 0, bytesIn: 0, bytesOut: 0 };

/* ---------------------------------------------------------------- helpers */

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const kb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

/** "2019-toyota-camry-se" -> { year, make, model } */
function parseSlug(slug) {
  const words = slug.split(/[-_\s]+/).filter(Boolean);
  let year = null;
  const yi = words.findIndex((w) => /^(19|20)\d{2}$/.test(w));
  if (yi > -1) { year = Number(words[yi]); words.splice(yi, 1); }

  let make = '';
  const lower = words.map((w) => w.toLowerCase());
  for (const m of MAKES) {
    const parts = m.toLowerCase().split(/[-\s]/);
    if (parts.every((p, i) => lower[i] === p)) { make = m; words.splice(0, parts.length); break; }
  }
  if (!make && words.length) { make = titleCase(words.shift()); }

  return { year, make, model: titleCase(words.join(' ')) };
}

/** Write a car.json stub so there is always something to edit. */
function ensureCarFile(dir, slug) {
  const file = path.join(dir, 'car.json');
  if (fs.existsSync(file)) return readJSON(file, {});

  const { year, make, model } = parseSlug(slug);
  const stub = {
    title: [year, make, model].filter(Boolean).join(' ') || titleCase(slug.replace(/-/g, ' ')),
    make, model, year,
    price: 0,
    negotiable: true,
    condition: 'Foreign Used',
    registration: 'Registered',
    mileage: null,
    transmission: 'Automatic',
    fuel: 'Petrol',
    engine: '',
    drivetrain: '',
    bodyType: '',
    colour: '',
    interior: '',
    seats: 5,
    location: 'Kumasi',
    status: 'available',
    featured: false,
    sortOrder: 100,
    description: 'Add the sales pitch here. Two or three lines is plenty.',
    features: [],
    cover: ''
  };
  fs.writeFileSync(file, JSON.stringify(stub, null, 2) + '\n');
  console.log(`  + created cars/${slug}/car.json — fill in the price and details`);
  return stub;
}

/** Photos sort: cover first, then filename order. Prefix files 01_, 02_ to control it. */
function collectPhotos(dir, coverHint) {
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  if (coverHint) {
    const i = files.findIndex((f) => f.toLowerCase() === coverHint.toLowerCase());
    if (i > 0) files.unshift(files.splice(i, 1)[0]);
  } else {
    const i = files.findIndex((f) => /^(cover|main|front)/i.test(f));
    if (i > 0) files.unshift(files.splice(i, 1)[0]);
  }
  return files;
}

/* ----------------------------------------------------------------- images */

/**
 * Turn one source photo into a set of WebP renditions.
 * Cached by file content hash, so re-running the build costs nothing.
 * Returns { src, srcset } — or a plain copy if sharp is unavailable.
 */
async function processPhoto(srcFile, slug, name) {
  const buf = fs.readFileSync(srcFile);
  stats.bytesIn += buf.length;
  const outDir = path.join(DIST, 'cars', slug);
  fs.mkdirSync(outDir, { recursive: true });

  if (!sharp) {
    fs.writeFileSync(path.join(outDir, name), buf);
    stats.bytesOut += buf.length;
    stats.copied++;
    return { src: `cars/${slug}/${name}`, srcset: '' };
  }

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9_-]/g, '');
  const meta = await sharp(buf).metadata();
  const srcWidth = meta.width || Math.max(...WIDTHS);

  // never upscale: keep only widths the original can actually fill, plus one
  const widths = WIDTHS.filter((w) => w <= srcWidth);
  if (!widths.length) widths.push(srcWidth);

  const parts = [];
  for (const w of widths) {
    const outName = `${base}-${hash}-${w}.webp`;
    const cacheFile = path.join(CACHE, outName);
    const distFile = path.join(outDir, outName);

    if (fs.existsSync(cacheFile)) {
      fs.copyFileSync(cacheFile, distFile);
      stats.cached++;
    } else {
      await sharp(buf)
        .rotate()                                   // respect EXIF orientation from phones
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: QUALITY, effort: 4 })
        .toFile(distFile);
      fs.mkdirSync(CACHE, { recursive: true });
      fs.copyFileSync(distFile, cacheFile);
      stats.made++;
    }
    stats.bytesOut += fs.statSync(distFile).size;
    parts.push({ w, url: `cars/${slug}/${outName}` });
  }

  const largest = parts[parts.length - 1];
  const preferred = parts.find((p) => p.w === 960) || largest;
  return {
    src: preferred.url,
    srcset: parts.map((p) => `${p.url} ${p.w}w`).join(', ')
  };
}

/* ------------------------------------------------------------------ build */

async function build() {
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

  // 1. site shell
  fs.cpSync(SRC_DIR, DIST, { recursive: true });

  // 2. brand + contact config
  const site = readJSON(path.join(ROOT, 'data', 'site.json'), {});

  // 3. scan the cars folder
  if (!fs.existsSync(CARS_DIR)) fs.mkdirSync(CARS_DIR, { recursive: true });
  const slugs = fs.readdirSync(CARS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name);

  const cars = [];
  for (const slug of slugs) {
    const dir = path.join(CARS_DIR, slug);
    const meta = ensureCarFile(dir, slug);
    const files = collectPhotos(dir, meta.cover);

    if (!files.length) {
      console.warn(`  ! skipped cars/${slug} — no photos in the folder yet`);
      continue;
    }
    if (meta.hidden === true) {
      console.log(`  · hidden cars/${slug}`);
      continue;
    }

    const photos = [];
    for (const f of files) photos.push(await processPhoto(path.join(dir, f), slug, f));

    const fallback = parseSlug(slug);
    cars.push({
      slug,
      title: meta.title || [fallback.year, fallback.make, fallback.model].filter(Boolean).join(' '),
      make: meta.make || fallback.make || '',
      model: meta.model || fallback.model || '',
      year: meta.year ?? fallback.year ?? null,
      price: Number(meta.price) || 0,
      negotiable: meta.negotiable !== false,
      condition: meta.condition || '',
      registration: meta.registration || '',
      mileage: meta.mileage ?? null,
      transmission: meta.transmission || '',
      fuel: meta.fuel || '',
      engine: meta.engine || '',
      drivetrain: meta.drivetrain || '',
      bodyType: meta.bodyType || '',
      colour: meta.colour || meta.color || '',
      interior: meta.interior || '',
      seats: meta.seats ?? null,
      location: meta.location || site.location || '',
      status: (meta.status || 'available').toLowerCase(),
      featured: meta.featured === true,
      sortOrder: Number(meta.sortOrder) || 100,
      description: meta.description || '',
      features: Array.isArray(meta.features) ? meta.features : [],
      photos,
      addedAt: fs.statSync(dir).birthtimeMs || Date.now()
    });
  }

  // featured first, then sortOrder, then newest folder
  cars.sort((a, b) =>
    (b.featured - a.featured) || (a.sortOrder - b.sortOrder) || (b.addedAt - a.addedAt));

  const payload = { site, cars, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DIST, 'data', 'inventory.json'), JSON.stringify(payload, null, 2));

  pruneCache();

  const live = cars.filter((c) => c.status !== 'sold').length;
  const saved = stats.bytesIn ? Math.round((1 - stats.bytesOut / stats.bytesIn) * 100) : 0;
  console.log(`\nHALO AUTOS — ${cars.length} listing(s), ${live} available.`);
  if (sharp) {
    console.log(`Photos: ${stats.made} resized, ${stats.cached} from cache.`);
    console.log(`Weight: ${kb(stats.bytesIn)} of originals → ${kb(stats.bytesOut)} served (${saved}% lighter).`);
  } else {
    console.log(`Photos: ${stats.copied} copied at full size (${kb(stats.bytesOut)}).`);
  }
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Output: dist/\n`);
}

/** Drop cached renditions whose source photo no longer exists. */
function pruneCache() {
  const distCars = path.join(DIST, 'cars');
  if (!fs.existsSync(CACHE) || !fs.existsSync(distCars)) return;
  const live = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else live.add(e.name);
    }
  };
  walk(distCars);
  for (const f of fs.readdirSync(CACHE)) {
    if (!live.has(f)) fs.rmSync(path.join(CACHE, f), { force: true });
  }
}

build().catch((err) => { console.error('\nBuild failed:\n', err); process.exit(1); });
