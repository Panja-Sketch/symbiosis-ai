#pragma once
// Bounded in-RAM telemetry queue. When full, the OLDEST sample is dropped (and counted) so memory
// and flash use stay bounded and the newest observations survive. Samples keep their original
// observed time; nothing is re-timestamped. The queue is intentionally not persisted: a reboot
// loses unsent samples rather than wearing flash (documented limit).
#include <stddef.h>

namespace sym {

template <typename T, size_t N>
class BoundedQueue {
 public:
  BoundedQueue() : head_(0), size_(0), dropped_(0) {}

  void push(const T& v) {
    if (size_ == N) {  // overwrite the oldest
      head_ = (head_ + 1) % N;
      size_--;
      dropped_++;
    }
    items_[(head_ + size_) % N] = v;
    size_++;
  }

  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  size_t dropped() const { return dropped_; }
  static constexpr size_t capacity() { return N; }

  /** Copies up to `max` oldest items (in order) into `out`; returns how many. Does not remove. */
  size_t peek(T* out, size_t max) const {
    size_t n = size_ < max ? size_ : max;
    for (size_t i = 0; i < n; i++) out[i] = items_[(head_ + i) % N];
    return n;
  }

  /** Removes the `n` oldest items. */
  void pop(size_t n) {
    if (n > size_) n = size_;
    head_ = (head_ + n) % N;
    size_ -= n;
  }

 private:
  T items_[N];
  size_t head_;
  size_t size_;
  size_t dropped_;
};

}  // namespace sym
