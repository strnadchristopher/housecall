use glib::variant::ToVariant;
#[test]
fn optimized_string_variant_iteration_uses_valid_output_pointer() {
    let values = ["first", "middle", "last"];
    let variant = values.to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some("middle"));
    assert_eq!(iter.next(), None);
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
    assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("middle"));
    assert_eq!(variant.array_iter_str().unwrap().nth_back(1), Some("middle"));
}
