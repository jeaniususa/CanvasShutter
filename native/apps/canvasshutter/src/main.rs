//! CanvasShutter native, Sprint 1 spike.
//!
//! Proves the core idea of the native editor: our own wgpu pipeline draws a
//! texture inside an egui panel. Real photos arrive in Sprint 2.

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

struct App;

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let render_state = cc
            .wgpu_render_state
            .as_ref()
            .expect("CanvasShutter needs the wgpu renderer");
        let resources = PhotoResources::new(
            &render_state.device,
            &render_state.queue,
            render_state.target_format,
        );
        render_state
            .renderer
            .write()
            .callback_resources
            .insert(resources);
        App
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::SidePanel::right("adjustments").show(ctx, |ui| {
            ui.heading("Adjustments");
            ui.label("Sliders arrive in Sprint 4.");
        });
        egui::CentralPanel::default().show(ctx, |ui| {
            let rect = fit_square(ui.available_rect_before_wrap());
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, PhotoCallback));
        });
    }
}

/// The largest square that fits in `area`, centred. The test pattern is square.
fn fit_square(area: egui::Rect) -> egui::Rect {
    let side = area.width().min(area.height());
    egui::Rect::from_center_size(area.center(), egui::vec2(side, side))
}

/// GPU objects created once at start-up and kept in egui's callback resources.
struct PhotoResources {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
}

impl PhotoResources {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, target: wgpu::TextureFormat) -> Self {
        let side = test_pattern::SIZE;
        let size = wgpu::Extent3d {
            width: side,
            height: side,
            depth_or_array_layers: 1,
        };
        // Plain Rgba8Unorm (not sRGB): egui draws into a non-sRGB target, so the
        // bytes pass straight through. Linear-light editing comes in Sprint 2.
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
            &test_pattern::rgba(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * side),
                rows_per_image: Some(side),
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
