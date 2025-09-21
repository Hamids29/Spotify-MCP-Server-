// Authorization token that must have been created previously. See : https://developer.spotify.com/documentation/web-api/concepts/authorization
const token = 'BQCcuAXtY5y_BVZEKT2NxauHv9hjvso6UFX6rD7S0vOrqOj5O9liA0hfHx_tVr0nw0BmBKZT0XXY-rW4b3obYIds_SncYjIrZeyAP8dmQcE0n34ZgWh5lytEPhIdG3TXsKW8yO2_WBvp_Jh81nw6ViDMGUGw6-_4y11XrUX6qjUFTr1NPixZCLtICRCrAGHDgGPiX5Hb2YaNahyXcAG-DL8foCvVUWyklCdXraTF22COO8zTBGlDkBZemusTN-fmI4k8-bJZcfF7AtVGgzDyvrmLU61xdHaYEYn54YKrR6RRyJ7v2YxegTKx-AAf9rcU';
async function fetchWebApi(endpoint, method, body) {
  const res = await fetch(`https://api.spotify.com/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    method,
    body:JSON.stringify(body)
  });
  return await res.json();
}

async function getTopTracks(){
  // Endpoint reference : https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks
  return (await fetchWebApi(
    'v1/me/top/tracks?time_range=long_term&limit=5', 'GET'
  )).items;
}

const topTracks = await getTopTracks();
console.log(
  topTracks?.map(
    ({name, artists}) =>
      `${name} by ${artists.map(artist => artist.name).join(', ')}`
  )
);