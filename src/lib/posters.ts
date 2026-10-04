// Poster photos (Unsplash, free licence) in public/posters, matched on the event title.
const POSTER_PHOTOS: [RegExp, string][] = [
  [/coldplay/i, "coldplay"],
  [/india vs pakistan/i, "ind-vs-pak"],
  [/mumbai indians|ipl/i, "mi-vs-csk"],
  [/arijit/i, "arijit"],
  [/zakir/i, "zakir-khan"],
  [/bit n build/i, "bit-n-build"],
  [/diljit/i, "diljit"],
  [/sunburn|garrix/i, "sunburn"],
  [/phantom/i, "phantom"],
  [/ed sheeran/i, "ed-sheeran"],
  [/india vs australia|border-gavaskar/i, "ind-vs-aus"],
  [/bassi/i, "bassi"],
  [/rahman/i, "ar-rahman"],
];
export function posterPhoto(title: string): string | null {
  const hit = POSTER_PHOTOS.find(([re]) => re.test(title));
  return hit ? `/posters/${hit[1]}.jpg` : null;
}
