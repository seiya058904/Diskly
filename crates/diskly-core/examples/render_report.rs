//! Renders report data from a JSON file into the report page, so the page can be
//! looked at and tested with made-up data:
//! `cargo run -p diskly-core --example render_report -- data.json out.html`

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        eprintln!("usage: render_report <data.json> <out.html>");
        std::process::exit(2);
    };
    let text = std::fs::read_to_string(input).expect("cannot read the data file");
    let data: serde_json::Value = serde_json::from_str(&text).expect("the data file is not JSON");
    let page = diskly_core::report::render(&data).expect("cannot render");
    std::fs::write(output, page).expect("cannot write the page");
}
