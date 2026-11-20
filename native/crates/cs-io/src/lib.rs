//! Reading photos from disk. No UI or GPU code lives here.

use std::path::Path;

/// A decoded photo: 8-bit RGBA pixels, row by row, top-left first.
pub struct Photo {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Reads and decodes a JPEG or PNG. The format is detected from the file's
/// contents, not its name. Errors come back as a short message for the user.
pub fn decode(path: &Path) -> Result<Photo, String> {
    let image = image::ImageReader::open(path)
        .map_err(|e| format!("Couldn't read the file: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Couldn't read the file: {e}"))?
        .decode()
        .map_err(|e| format!("Not a photo CanvasShutter can open: {e}"))?
        .to_rgba8();
    Ok(Photo {
        width: image.width(),
        height: image.height(),
        rgba: image.into_raw(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file in the system temp folder, named per test so tests can run in parallel.
    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("cs-io-test-{name}"));
        std::fs::write(&path, bytes).expect("temp folder is writable");
        path
    }

    #[test]
    fn decodes_png_pixels() {
        let source = image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 255])
            .expect("buffer matches size");
        let mut png = Vec::new();
        source
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode test PNG");
        // Named .jpg on purpose: the format must come from the contents.
        let photo = decode(&temp_file("red-blue.jpg", &png)).expect("valid PNG");
        assert_eq!((photo.width, photo.height), (2, 1));
        assert_eq!(photo.rgba, vec![255, 0, 0, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_photo() {
        let path = temp_file("not-a-photo.jpg", b"hello");
        assert!(decode(&path).is_err());
    }

    #[test]
    fn reports_a_missing_file() {
        assert!(decode(Path::new("/no/such/photo.jpg")).is_err());
    }
}
