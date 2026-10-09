// nowplaying: read the scrolling "now playing" marquee of the Claude FM stream.
//
// Input, one of:
//   nowplaying --raw W H [--debug]   gray8 frames (W*H bytes each) on stdin, e.g. from
//                                    ffmpeg ... -f rawvideo -pix_fmt gray -
//   nowplaying [--debug] a.png b.png ...   image files in time order
// Output: one JSON line {"track","artist","title","complete","frames"[, "fragments"]}
//
// The marquee pauses for ~2-3 s with the start of "Artist — Title" at the left edge, then
// scrolls left (~5 chars/s) and loops. We OCR every frame with macOS Vision, take the
// last pause (run of >=3 identical readings) as the start, then stitch later fragments
// by anchoring each one's interior inside the text so far, until the start text comes
// around again (one full loop).

import AppKit
import Foundation
import Vision

func recognize(_ cg: CGImage) -> String {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US"]
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    let obs = (req.results ?? []).sorted { $0.boundingBox.minX < $1.boundingBox.minX }
    let s = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    return s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func grayImage(_ bytes: Data, _ w: Int, _ h: Int) -> CGImage? {
    guard let provider = CGDataProvider(data: bytes as CFData) else { return nil }
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w,
                   space: CGColorSpaceCreateDeviceGray(),
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

// Find `needle` in `hay` at or after `from`; returns the start index.
func find(_ needle: [Character], in hay: [Character], from: Int) -> Int? {
    if needle.isEmpty || hay.count < needle.count { return nil }
    var i = max(0, from)
    while i + needle.count <= hay.count {
        if Array(hay[i..<(i + needle.count)]) == needle { return i }
        i += 1
    }
    return nil
}

struct Stitch { var text: String; var complete: Bool }

// Stitch fragments that follow a pause whose reading is `start`.
func stitch(start: String, after: [String]) -> Stitch {
    var merged = Array(start)
    let head = Array(start.prefix(min(10, start.count)))
    var pPrev = 0
    for frag in after {
        var g = Array(frag)
        if g.count > 8 { g = Array(g[1..<(g.count - 1)]) }  // edge glyphs are often clipped
        var placed = false
        outer: for o in 0...min(3, max(0, g.count - 5)) {
            for k in [8, 6, 5] where o + k <= g.count {
                let anchor = Array(g[o..<(o + k)])
                if let p = find(anchor, in: merged, from: pPrev) {
                    merged = Array(merged[0..<p]) + Array(g[o...])
                    pPrev = p
                    placed = true
                    break outer
                }
            }
        }
        if !placed { continue }
        if head.count >= 4, let idx = find(head, in: merged, from: 1) {
            let t = String(merged[0..<idx]).trimmingCharacters(in: .whitespaces)
            return Stitch(text: t, complete: true)
        }
    }
    // The loop may have wrapped only partly: "...Made It Kyl" ends with the start of `head`.
    if head.count >= 4 {
        for k in stride(from: head.count - 1, through: 3, by: -1) {
            let cut = merged.count - k
            if cut > start.count / 2, cut > 0, merged[cut - 1] == " ",
               Array(merged[cut...]) == Array(head[0..<k]) {
                let t = String(merged[0..<cut]).trimmingCharacters(in: .whitespaces)
                return Stitch(text: t, complete: true)
            }
        }
    }
    return Stitch(text: String(merged).trimmingCharacters(in: .whitespaces), complete: false)
}

func solve(_ frags: [String]) -> Stitch {
    let f = frags.map { $0.trimmingCharacters(in: .whitespaces) }
    if f.isEmpty { return Stitch(text: "", complete: false) }
    // Runs of >=3 identical readings = the pause at the start of the loop.
    var runs: [(start: Int, end: Int)] = []
    var i = 0
    while i < f.count {
        var j = i
        while j + 1 < f.count && f[j + 1] == f[i] { j += 1 }
        if j - i + 1 >= 3 && f[i].count >= 4 { runs.append((i, j)) }
        i = j + 1
    }
    if runs.isEmpty {
        if Set(f).count == 1 { return Stitch(text: f[0], complete: f.count >= 6) }
        return stitch(start: f[0], after: Array(f.dropFirst()))
    }
    let last = runs[runs.count - 1]
    let latest = stitch(start: f[last.start], after: Array(f[(last.end + 1)...]))
    if latest.complete { return latest }
    // Fall back to an earlier loop of the same track.
    let latestHead = String(f[last.start].prefix(8))
    for r in runs.dropLast().reversed() {
        let s = stitch(start: f[r.start], after: Array(f[(r.end + 1)...]))
        if s.complete && s.text.hasPrefix(latestHead) { return s }
    }
    return latest
}

func splitTrack(_ t: String) -> (String, String) {
    for sep in [" — ", " – ", " - "] {
        if let r = t.range(of: sep) {
            return (String(t[..<r.lowerBound]), String(t[r.upperBound...]))
        }
    }
    return ("", t)
}

func jsonString(_ s: String) -> String {
    let d = try! JSONSerialization.data(withJSONObject: [s], options: [])
    let a = String(data: d, encoding: .utf8)!
    return String(a.dropFirst().dropLast())
}

// MARK: main
var args = Array(CommandLine.arguments.dropFirst())
let debug = args.contains("--debug")
args.removeAll { $0 == "--debug" }
var frags: [String] = []

if args.first == "--raw", args.count >= 3, let w = Int(args[1]), let h = Int(args[2]) {
    let size = w * h
    let input = FileHandle.standardInput
    var buf = Data()
    while true {
        let chunk = input.readData(ofLength: 1 << 20)
        if chunk.isEmpty { break }
        buf.append(chunk)
        while buf.count >= size {
            let frame = buf.prefix(size)
            buf = buf.dropFirst(size)
            if let cg = grayImage(Data(frame), w, h) { frags.append(recognize(cg)) }
        }
    }
} else {
    for p in args {
        guard let img = NSImage(contentsOfFile: p),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
        frags.append(recognize(cg))
    }
}

let r = solve(frags)
let (artist, title) = splitTrack(r.text)
let track = artist.isEmpty ? title : "\(artist) — \(title)"
var out = "{\"track\":\(jsonString(track)),\"artist\":\(jsonString(artist)),\"title\":\(jsonString(title)),\"complete\":\(r.complete),\"frames\":\(frags.count)"
if debug { out += ",\"fragments\":[" + frags.map(jsonString).joined(separator: ",") + "]" }
print(out + "}")
