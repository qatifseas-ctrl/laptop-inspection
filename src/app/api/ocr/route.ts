import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/ocr
 * Body: { image: "data:image/jpeg;base64,..." , target: "assetNo" | "serialNumber" }
 *
 * Uses VLM (vision model) to read the Asset Tag / Serial Number from a photo.
 * Much more accurate than Tesseract.js for real-world photos of laptop stickers
 * (low contrast, rotated, complex backgrounds, mixed Arabic/English text).
 */
export async function POST(req: NextRequest) {
  try {
    const { image, target } = await req.json()

    if (!image || typeof image !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'image (data URL) is required' },
        { status: 400 }
      )
    }

    const targetField =
      target === 'serialNumber' ? 'Serial Number' : 'Asset Tag'

    // Prompt tuned for HP/Lenovo enterprise laptops with Aramco-style asset tags.
    // The asset pattern is EX91X + 8 digits (e.g. EX91X23070455).
    const prompt = `You are an OCR engine specialized in reading asset tag stickers on laptops.

Look at this photo carefully. Find the "${targetField}" — it is usually printed on a white sticker labeled "Property of", "Asset Tag", "Asset No", "HP Asset", or similar.

Asset Tag format: typically "EX91X" followed by 8 digits (e.g. EX91X23070455).
Serial Number format: typically 7-10 alphanumeric characters, sometimes labeled "S/N" or "Serial".

CRITICAL INSTRUCTIONS:
- Read the number EXACTLY as printed. Do not add spaces or dashes.
- Ignore Arabic text, barcodes, company logos, and other numbers.
- If the image is rotated, mentally rotate it back before reading.
- If you cannot find the requested number, respond with exactly: NOT_FOUND

Respond with ONLY the raw number (no explanation, no quotes, no labels).
If found, output the number. If not found, output: NOT_FOUND`

    const zai = await ZAI.create()

    const response = await zai.chat.completions.createVision({
      model: 'glm-4.5v',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    })

    const content =
      (response.choices?.[0]?.message?.content as string | undefined)?.trim() ||
      ''

    if (!content || content.toUpperCase() === 'NOT_FOUND') {
      return NextResponse.json({
        ok: true,
        found: false,
        raw: '',
        message: 'لم يتم العثور على الرقم في الصورة',
      })
    }

    // Clean up the response: take only the first alphanumeric token
    // (VLM sometimes adds punctuation or extra text)
    const cleaned = content
      .replace(/```/g, '')
      .replace(/[*_"'\s]/g, '')
      .toUpperCase()
      .split(/[\n,;]/)[0]
      .trim()

    // For asset, also try to extract just the EX91X... pattern if present
    let final = cleaned
    if (target === 'assetNo') {
      const m = cleaned.match(/EX\d{2}X\d{6,8}/)
      if (m) final = m[0]
    }

    return NextResponse.json({
      ok: true,
      found: true,
      value: final,
      raw: content,
    })
  } catch (err: any) {
    console.error('OCR API error:', err)
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || 'Unknown error',
        message: 'فشل استدعاء خدمة OCR الذكية',
      },
      { status: 500 }
    )
  }
}
