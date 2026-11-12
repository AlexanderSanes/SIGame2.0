// Временный захардкоженный пакет для этапа 2 (позже заменится загрузкой из packages/)
export const TEST_PACK = {
  id: 'test-pack',
  title: 'Тестовый пакет',
  rounds: [
    {
      title: 'Раунд 1',
      themes: [
        {
          title: 'География',
          questions: [
            { price: 100, text: 'Столица Франции?', answer: 'Париж' },
            { price: 200, text: 'Самая длинная река Европы?', answer: 'Волга' },
            { price: 300, text: 'Флаг какой страны изображён на картинке?', answer: 'Россия', media: [{ type: 'image', src: '/testpack-media/flag.png' }] },
          ],
        },
        {
          title: 'Наука',
          questions: [
            { price: 100, text: 'Химический символ золота?', answer: 'Au' },
            { price: 200, text: 'Сколько планет в Солнечной системе?', answer: '8' },
            { price: 300, text: 'Какой тон звучит? (примерная частота)', answer: '440 Гц (нота ля первой октавы)', media: [{ type: 'audio', src: '/testpack-media/tone.wav' }] },
          ],
        },
      ],
    },
    {
      title: 'Раунд 2',
      themes: [
        {
          title: 'Кино',
          questions: [
            { price: 200, text: 'Режиссёр «Титаника»?', answer: 'Джеймс Кэмерон' },
            { price: 400, text: 'Год выхода первого «Терминатора»?', answer: '1984' },
            { price: 600, text: 'Клип какого исполнителя сейчас на экране?', answer: 'Рик Эстли', media: [{ type: 'youtube', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] },
          ],
        },
        {
          title: 'Спорт',
          questions: [
            { price: 200, text: 'Сколько игроков футбольной команды одновременно на поле?', answer: '11' },
            { price: 400, text: 'Страна — родина дзюдо?', answer: 'Япония' },
            { price: 600, text: 'Сколько колец на олимпийском флаге?', answer: '5', answerMedia: [{ type: 'image', src: '/testpack-media/rings.png' }] },
          ],
        },
      ],
    },
  ],
};
