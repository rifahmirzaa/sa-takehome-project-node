const books = [
  {
    id: '1',
    title: 'The Art of Doing Science and Engineering',
    author: 'Richard Hamming',
    description: 'The Art of Doing Science and Engineering is a reminder that a childlike capacity for learning and creativity are accessible to everyone.',
    image: '/images/art-science-eng.jpg',
    amount: 2300,
    currency: 'usd'
  },
  {
    id: '2',
    title: 'The Making of Prince of Persia: Journals 1985-1993',
    author: 'Jordan Mechner',
    description: 'In The Making of Prince of Persia, on the 30th anniversary of the game’s release, Mechner looks back at the journals he kept from 1985 to 1993..',
    image: '/images/prince-of-persia.jpg',
    amount: 2500,
    currency: 'usd'
  },
  {
    id: '3',
    title: 'Working in Public: The Making and Maintenance of Open Source',
    author: 'Nadia Eghbal',
    description: 'Nadia Eghbal takes an inside look at modern open source and offers a model through which to understand the challenges faced by online creators.',
    image: '/images/working-in-public.jpg',
    amount: 2800,
    currency: 'usd'
  }
];

function getBookById(id) {
  // Match only exact string identifiers to prevent numeric type coercion
  if (typeof id !== 'string') {
    return null;
  }
  return books.find((book) => book.id === id) || null;
}

module.exports = {
  books,
  getBookById
};
