//! def 线格式对拍 golden 生成器:输出 wire_codec.rs 编解码器全样本
//! (标量/容器/属性流/方法帧/消息帧)JSON,内置往返自校验。
//!
//! golden 由 Rust 产出为规范推导(provenance 引 kbengine 源 file:line);
//! tests/wire_codec_units.rs 重生成比对 + 畸形流不 panic(同 flag-domains 模式)。

fn main() {
    print!("{}", kode_server::wire_codec::dump_wire_golden());
    println!();
}
