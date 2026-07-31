# `wgpu` Graphics Pipeline

## Konsep Utama
`wgpu` adalah standar GPU API di ekosistem Rust berdasarkan inisiatif WebGPU. Ia berjalan secara native (menerjemahkan perintah ke Vulkan, Metal, atau DirectX 12) maupun di web (WebGL/WebGPU). Framework ini memastikan keamanan tipe dan model asinkron di Rust, sangat kuat untuk render hardware-accelerated 2D, 3D, maupun perhitungan paralel via Compute Shader (WGSL).

## Arsitektur & Flow
```ascii
  [ WGSL Shader (Vertex & Fragment) ]
                  |
[ Render Pipeline (Layout, Colors, Blending) ]
                  |
    [ Command Encoder ] <--- [ Buffers (Vertex, Index, Uniforms) ]
                  |
      [ Command Buffer ] 
                  |
      [ GPU Queue Submission ] -> [ Render to Surface Texture ]
```

## Production-Ready Code
```rust
use wgpu::util::DeviceExt;
use std::borrow::Cow;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 3],
    color: [f32; 3],
}

const VERTICES: &[Vertex] = &[
    Vertex { position: [0.0, 0.5, 0.0], color: [1.0, 0.0, 0.0] },
    Vertex { position: [-0.5, -0.5, 0.0], color: [0.0, 1.0, 0.0] },
    Vertex { position: [0.5, -0.5, 0.0], color: [0.0, 0.0, 1.0] },
];

pub struct State {
    surface: wgpu::Surface,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    render_pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
}

impl State {
    // Memerlukan parameter Window yang valid dari Winit
    // pub async fn new(window: &Window) -> Self { ... }

    pub fn render(&mut self) -> Result<(), wgpu::SurfaceError> {
        let output = self.surface.get_current_texture()?;
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.1, g: 0.2, b: 0.3, a: 1.0,
                        }),
                        store: true, // WGPU 0.19+ flag
                    },
                })],
                depth_stencil_attachment: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            render_pass.draw(0..3, 0..1);
        } // Drop render pass explicit

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vertex_layout() {
        assert_eq!(std::mem::size_of::<Vertex>(), 24);
    }
}
```

## Anti-Patterns
1. **Tidak melepas scope RenderPass**: 
   *Mengapa Berbahaya:* `begin_render_pass()` meminjam (mutably borrows) encoder. Jika block meminjam ini tidak ditutup secara eksplisit via scope brackets `{ ... }` atau manual `drop()`, anda tidak bisa memanggil `encoder.finish()` yang akan merusak kompilasi Rust checker (Borrow Checker).
2. **Buffer alokasi berulang kali di render loop**:
   *Mengapa Berbahaya:* Membuat `wgpu::Buffer` baru pada setiap iterasi frame menyebabkan latensi drastis karena pengalokasian memori video (VRAM) sangat lambat. Buffers wajib diinisialisasi sekali lalu di-_update_ kontennya via `queue.write_buffer()`.

## Edge Cases & Defensive Programming
- **Swapchain/Surface Loss**: OS bisa merebut memori window/surface saat monitor dipadamkan atau suspend (misalnya `SurfaceError::Lost` atau `Outdated`). Anda wajib men-cek error saat `get_current_texture()` dan menginisialisasi ulang konfigurasi (reconfigure surface).
- **Alignment Rules WGSL (Std140/Std430)**: Binding Uniform buffer antara Rust tipe dan tipe Shader memiliki padding memori ketat. Struktur `vec3` di Rust memiliki ukuran memory 12 byte, sedangkan di shader sering di-align ke batas 16 byte. Gunakan `bytemuck` dan tipe `[f32; 4]` bahkan untuk vector 3D untuk meminimalkan kecacatan rendering (korupsi geometri).
