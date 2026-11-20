//! CanvasShutter native.
//!
//! Our own wgpu pipeline draws the photo inside an egui panel. Until a photo
//! is opened, a generated test pattern stands in for it.

use std::sync::mpsc;

use eframe::egui;
use eframe::egui_wgpu::{self, wgpu};

mod test_pattern;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("CanvasShutter")
            .with_inner_size([1200.0, 800.0]),
        ..Default::default()
    };
    eframe::run_native(
        "CanvasShutter",
        options,
        Box::new(|cc| Ok(Box::new(App::new(cc)))),
    )
}

struct App {
    /// Width and height of the photo on screen, used to keep its shape.
    photo_size: [u32; 2],
    /// Set while a photo is being decoded on a background thread; the thread
    /// sends its result through this channel when it's done.
    opening: Option<mpsc::Receiver<Result<cs_io::Photo, String>>>,
    /// The last "couldn't open" message, shown under the Open button.
    error: Option<String>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let render_state = cc
            .wgpu_render_state
            .as_ref()
            .expect("CanvasShutter needs the wgpu renderer");
        let side = test_pattern::SIZE;
        show_photo(render_state, side, side, &test_pattern::rgba());
        App {
            photo_size: [side, side],
            opening: None,
            error: None,
        }
    }

    /// Asks for a file, then decodes it on a background thread so the window
    /// stays responsive while a large photo loads.
    fn open_photo(&mut self, ctx: &egui::Context) {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Photos", &["jpg", "jpeg", "png"])
            .pick_file()
        else {
            return; // The user cancelled.
        };
        let (sender, receiver) = mpsc::channel();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            // If the app has closed meanwhile, nobody is listening; that's fine.
            let _ = sender.send(cs_io::decode(&path));
            ctx.request_repaint();
        });
        self.opening = Some(receiver);
        self.error = None;
    }

    /// Picks up a finished decode, if there is one, and puts it on screen.
    fn receive_photo(&mut self, frame: &eframe::Frame) {
        let Some(receiver) = &self.opening else {
            return;
        };
        let result = match receiver.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return, // Still decoding.
            Err(mpsc::TryRecvError::Disconnected) => Err("Opening the photo failed.".into()),
        };
        self.opening = None;
        let Some(render_state) = frame.wgpu_render_state() else {
            return;
        };
        match result {
            Ok(photo) => {
                let limit = render_state.device.limits().max_texture_dimension_2d;
                if photo.width > limit || photo.height > limit {
                    self.error = Some(format!(
                        "This photo is {}×{} pixels; this computer can show up to {limit} per side.",
                        photo.width, photo.height
                    ));
                    return;
                }
                show_photo(render_state, photo.width, photo.height, &photo.rgba);
                self.photo_size = [photo.width, photo.height];
            }
            Err(message) => self.error = Some(message),
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        self.receive_photo(frame);
        egui::SidePanel::right("adjustments").show(ctx, |ui| {
            let opening = self.opening.is_some();
            if ui
                .add_enabled(!opening, egui::Button::new("Open…"))
                .clicked()
            {
                self.open_photo(ctx);
            }
            if opening {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Opening…");
                });
            }
            if let Some(error) = &self.error {
                ui.colored_label(ui.visuals().error_fg_color, error);
            }
            ui.separator();
            ui.heading("Adjustments");
            ui.label("Sliders arrive in Sprint 4.");
        });
        egui::CentralPanel::default().show(ctx, |ui| {
            let [width, height] = self.photo_size;
            let rect = fit(ui.available_rect_before_wrap(), width, height);
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, PhotoCallback));
        });
    }
}

/// Uploads pixels to the GPU and makes them the photo the callback draws,
/// replacing the previous one.
fn show_photo(render_state: &egui_wgpu::RenderState, width: u32, height: u32, rgba: &[u8]) {
    let resources = PhotoResources::new(
        &render_state.device,
        &render_state.queue,
        render_state.target_format,
        width,
        height,
        rgba,
    );
    render_state
        .renderer
        .write()
        .callback_resources
        .insert(resources);
}

/// The largest rectangle with the photo's shape that fits in `area`, centred.
fn fit(area: egui::Rect, width: u32, height: u32) -> egui::Rect {
    let scale = (area.width() / width as f32).min(area.height() / height as f32);
    let size = egui::vec2(width as f32, height as f32) * scale;
    egui::Rect::from_center_size(area.center(), size)
}

/// GPU objects for the current photo, kept in egui's callback resources.
/// Opening a photo builds a new set that replaces the old one.
struct PhotoResources {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
}

impl PhotoResources {
    fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: wgpu::TextureFormat,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Self {
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        // Plain Rgba8Unorm (not sRGB): egui draws into a non-sRGB target, so the
        // bytes pass straight through. Linear-light editing comes in a later sprint.
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("photo"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: Some(height),
            },
            size,
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("photo"),
            source: wgpu::ShaderSource::Wgsl(include_str!("photo.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("photo"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(target.into())],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("photo"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        Self {
            pipeline,
            bind_group,
        }
    }
}

/// Draws the photo texture into the rectangle egui gives the callback.
struct PhotoCallback;

impl egui_wgpu::CallbackTrait for PhotoCallback {
    fn paint(
        &self,
        _info: egui::PaintCallbackInfo,
        render_pass: &mut wgpu::RenderPass<'static>,
        resources: &egui_wgpu::CallbackResources,
    ) {
        let photo: &PhotoResources = resources.get().expect("inserted in App::new");
        render_pass.set_pipeline(&photo.pipeline);
        render_pass.set_bind_group(0, &photo.bind_group, &[]);
        render_pass.draw(0..3, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_a_wide_photo_wide_and_centred() {
        let area = egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(1000.0, 1000.0));
        let rect = fit(area, 4000, 2000);
        assert_eq!(rect.size(), egui::vec2(1000.0, 500.0));
        assert_eq!(rect.center(), area.center());
    }

    #[test]
    fn fit_keeps_a_tall_photo_tall() {
        let area = egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(800.0, 400.0));
        assert_eq!(fit(area, 100, 200).size(), egui::vec2(200.0, 400.0));
    }
}
