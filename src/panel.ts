export default class Panel {
  element: {
    phrase: HTMLHeadingElement;
    pinyin: HTMLHeadingElement;
    jyutping: HTMLHeadingElement;
    definitions: HTMLDivElement;
  }

  constructor() {
    this.element = {
      phrase: document.getElementById('phrase')! as HTMLHeadingElement,
      pinyin: document.getElementById('pinyin')! as HTMLHeadingElement,
      jyutping: document.getElementById('jyutping')! as HTMLHeadingElement,
      definitions: document.getElementById('definitions')! as HTMLDivElement
    }
  }

  get phrase() {
    return this.element.phrase.textContent!;
  }

  set phrase(phrase: string) {
    this.element.phrase.textContent = phrase;
  }

  set pinyin(pinyin: string) {
    this.element.pinyin.textContent = pinyin;
  }

  set jyutping(jyutping: string) {
    this.element.jyutping.textContent = jyutping;
  }

  set definitions(definitions: Array<string>) {
    this.element.definitions.replaceChildren();
    for (const definition of definitions) {
      const li = document.createElement('li');
      li.classList.add('mdc-list-item');
      const span_text = document.createElement('span');
      span_text.classList.add('mdc-list-item__text');
      span_text.textContent = definition;
      li.appendChild(span_text);
      this.element.definitions.appendChild(li);
    }
  }
}
