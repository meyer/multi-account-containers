const DEFAULT_FAVICON = '/img/blank-favicon.svg';

export function createFavIconElement(url: string) {
  const imageElement = document.createElement('img');
  imageElement.classList.add('icon', 'offpage');
  imageElement.src = url;
  const loadListener = (e: Event) => {
    if (!e.target) {
      throw new Error('could not load image');
    }
    (e.target as Element).classList.remove('offpage');
    e.target.removeEventListener('load', loadListener);
    e.target.removeEventListener('error', errorListener);
  };
  const errorListener: EventListener = e => {
    (e.target as HTMLImageElement).src = DEFAULT_FAVICON;
  };
  imageElement.addEventListener('error', errorListener);
  imageElement.addEventListener('load', loadListener);
  return imageElement;
}
