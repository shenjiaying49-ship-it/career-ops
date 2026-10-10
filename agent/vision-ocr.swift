// ─── macOS Vision 本地 OCR（截图识别导入用）───
// 用系统自带文字识别把图片里的中文/英文转成文本：不依赖网络、不上传图片。
// 编译：swiftc -O -o bin/vision-ocr vision-ocr.swift
// 用法：bin/vision-ocr /path/to/image.png   → stdout 输出识别文本（每行一条）

import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: vision-ocr <image-path>\n".data(using: .utf8)!)
    exit(1)
}

guard let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image: \(args[1])\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
