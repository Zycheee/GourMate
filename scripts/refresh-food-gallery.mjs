// Refresh verified remote gallery URLs and attribution; never download photographs.
import fs from "node:fs/promises";

const files = [
  "Chicken adobo.jpg", "Sinigang na Baboy.jpg",
  "Chicken tinola with green papaya and lemongrass.jpg", "Pancit bihon 1.jpg",
  "Beef Kaldereta olives.jpg", "Sinangag Recipe (Garlic Fried Rice).jpg",
  "Spaghetti Bolognese - Figaros, Brighton 2023-10-06.jpg", "Chicken stir fry.jpg",
  "Mixed vegetable curry 2.jpg", "Fried rice.jpg", "FoodOmelete.jpg", "Pasta al pomodoro 2.jpg"
];
const galleryPath = new URL("../backend/app/recipe/food-gallery.json", import.meta.url);
const directory = new URL("../frontend/public/food/", import.meta.url);
const gallery = JSON.parse(await fs.readFile(galleryPath, "utf8"));
const api = new URL("https://commons.wikimedia.org/w/api.php");
api.search = new URLSearchParams({ action: "query", format: "json", prop: "imageinfo",
  iiprop: "url|extmetadata", iiurlwidth: "800", titles: files.map(f => `File:${f}`).join("|") });
const response = await fetch(api);
if (!response.ok) throw new Error(`Commons metadata: ${response.status}`);
const result = await response.json();
const pages = Object.values(result.query.pages);
const plain = html => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
await fs.mkdir(directory, { recursive: true });
const records = [];
for (const [index, food] of gallery.entries()) {
  const info = pages.find(p => p.title === `File:${files[index]}`)?.imageinfo?.[0];
  if (!info) throw new Error(`Missing photo: ${files[index]}`);
  const metadata = info.extmetadata;
  const license = metadata.LicenseShortName?.value ?? "";
  if (!/^(CC BY(?:-SA)? [\d.]+|CC0|Public domain)$/i.test(license)) throw new Error(`Unapproved license: ${license}`);
  delete food.image_path;
  food.image_url = info.thumburl || info.url;
  food.image_credit = plain(metadata.Artist?.value ?? "Wikimedia Commons contributor");
  food.image_source = info.descriptionurl;
  food.image_license = license;
  records.push({ name: food.name, image_url: food.image_url, author: food.image_credit,
    source: info.descriptionurl, license, license_url: metadata.LicenseUrl?.value ?? "https://creativecommons.org/publicdomain/mark/1.0/",
    changes: "Wikimedia 800px thumbnail; cropped to fit the preview when displayed." });
  console.log(`Linked ${food.name} (${license})`);
}
await fs.writeFile(galleryPath, JSON.stringify(gallery, null, 2) + "\n");
await fs.writeFile(new URL("attributions.json", directory), JSON.stringify(records, null, 2) + "\n");
await fs.writeFile(new URL("ATTRIBUTIONS.md", directory), "# Food photograph attributions\n\nImages retain their original licenses. Photos load from Wikimedia URLs and are not bundled. These licenses apply to the photographs, not the application code.\n\n" + records.map(r =>
  `- **${r.name}** : ${r.author}. [Source](${r.source}); [${r.license}](${r.license_url}). ${r.changes}`
).join("\n") + "\n");
