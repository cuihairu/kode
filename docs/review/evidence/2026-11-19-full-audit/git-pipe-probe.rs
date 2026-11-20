#[path = "../../../../crates/kode-mcp/src/git_state.rs"]
mod git_state;
fn main() {
 let root=std::path::PathBuf::from(std::env::args().nth(1).unwrap());
 let count:usize=std::env::args().nth(2).unwrap().parse().unwrap();
 let candidates=(0..count).map(|i|root.join(format!("ignored_long_file_name_{i:08}.py"))).collect::<Vec<_>>();
 let r=git_state::probe(&root,&candidates);
 println!("available={} ignored={}",r.available,r.ignored.len());
}
