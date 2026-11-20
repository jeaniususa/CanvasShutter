//! A generated stand-in, shown until a photo is opened.

pub const SIZE: u32 = 256;

/// RGBA8 pixels: red rises left to right, green rises top to bottom, and the
/// blue channel makes a checkerboard so blurry scaling is easy to spot.
pub fn rgba() -> Vec<u8> {
    let mut pixels = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let blue: u8 = if (x / 32 + y / 32) % 2 == 0 { 255 } else { 160 };
            pixels.extend_from_slice(&[x as u8, y as u8, blue, 255]);
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_bytes_per_pixel() {
        assert_eq!(rgba().len(), (SIZE * SIZE * 4) as usize);
    }

    #[test]
    fn corners_have_expected_colours() {
        let px = rgba();
        let at = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            [px[i], px[i + 1], px[i + 2], px[i + 3]]
        };
        assert_eq!(at(0, 0), [0, 0, 255, 255]);
        assert_eq!(at(255, 255), [255, 255, 255, 255]);
        assert_eq!(at(255, 0), [255, 0, 160, 255]);
    }
}
