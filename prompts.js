'use strict';

// Each prompt is { category, word, hint }.
// Everyone except the imposter sees the category and the word.
// The imposter only sees the hint, which is deliberately vague.
const group = (category, hint, words) => words.map((word) => ({ category, word, hint }));

module.exports = [
  ...group('Animals', 'An animal', [
    'cat', 'dog', 'fish', 'elephant', 'penguin', 'giraffe',
    'butterfly', 'snake', 'rabbit', 'owl', 'turtle', 'octopus',
  ]),
  ...group('Food', 'Something to eat', [
    'pizza', 'banana', 'ice cream', 'hamburger', 'cake', 'apple',
    'sandwich', 'pancakes', 'pineapple', 'popcorn',
  ]),
  ...group('Around the house', 'Something you find indoors', [
    'chair', 'lamp', 'clock', 'key', 'bed', 'toothbrush',
    'mirror', 'television', 'candle', 'teapot',
  ]),
  ...group('Travel', 'A way to travel', [
    'bicycle', 'train', 'airplane', 'bus', 'sailboat',
    'hot air balloon', 'rocket', 'helicopter',
  ]),
  ...group('Nature', 'Something in nature', [
    'sun', 'tree', 'mountain', 'rainbow', 'flower', 'moon',
    'volcano', 'waterfall', 'cloud',
  ]),
  ...group('Clothes', 'Something you wear', [
    'hat', 'sock', 'sunglasses', 'scarf', 'shoe', 'jacket', 'tie',
  ]),
  ...group('Holiday', 'Something from a trip', [
    'suitcase', 'beach ball', 'sandcastle', 'swimming pool',
    'passport', 'camera', 'map', 'tent',
  ]),
  ...group('Fun and games', 'Something for fun', [
    'kite', 'guitar', 'football', 'balloon', 'skateboard',
    'chess', 'drum', 'yo-yo',
  ]),
];
