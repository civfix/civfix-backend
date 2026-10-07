/**
 * Static content pools for the LA demo seeder: names, neighborhoods, parks and the casual post, report and
 * event copy the generator samples from. Guard-free (no runIfMain) because seed-demo-la bundles it.
 */

import type { ReportType } from "@civfix/shared"

// About 70% of the cohort is Hispanic, with the rest reflecting LA's mix.

export const HISPANIC_FIRST_M = [
  "Jose",
  "Juan",
  "Carlos",
  "Luis",
  "Jorge",
  "Miguel",
  "Pedro",
  "Rafael",
  "Javier",
  "Alejandro",
  "Fernando",
  "Ricardo",
  "Eduardo",
  "Sergio",
  "Hector",
  "Oscar",
  "Raul",
  "Marco",
  "Cesar",
  "Diego",
  "Emiliano",
  "Mateo",
  "Santiago",
  "Sebastian",
  "Andres",
  "Cristian",
  "Ivan",
  "Erick",
  "Kevin",
  "Brandon",
  "Anthony",
  "Angel",
  "Jesus",
  "Ernesto",
  "Gerardo",
  "Rodrigo",
  "Ruben",
  "Salvador",
  "Armando",
  "Alfredo",
  "Enrique",
] as const

export const HISPANIC_FIRST_F = [
  "Maria",
  "Guadalupe",
  "Rosa",
  "Carmen",
  "Ana",
  "Leticia",
  "Veronica",
  "Claudia",
  "Adriana",
  "Gabriela",
  "Alejandra",
  "Daniela",
  "Mariana",
  "Valeria",
  "Ximena",
  "Camila",
  "Lucia",
  "Elena",
  "Isabel",
  "Sofia",
  "Paola",
  "Yesenia",
  "Marisol",
  "Araceli",
  "Esmeralda",
  "Karina",
  "Brenda",
  "Jessica",
  "Jasmine",
  "Vanessa",
  "Lorena",
  "Norma",
  "Silvia",
  "Patricia",
  "Sandra",
  "Monica",
  "Angelica",
  "Maribel",
  "Rocio",
  "Beatriz",
  "Josefina",
  "Cindy",
  "Nayeli",
  "Itzel",
  "Fatima",
  "Alondra",
  "Giselle",
  "Ashley",
  "Destiny",
  "Selena",
] as const

export const HISPANIC_LAST = [
  "Garcia",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Perez",
  "Sanchez",
  "Ramirez",
  "Torres",
  "Flores",
  "Rivera",
  "Gomez",
  "Diaz",
  "Reyes",
  "Morales",
  "Cruz",
  "Ortiz",
  "Gutierrez",
  "Chavez",
  "Ramos",
  "Ruiz",
  "Alvarez",
  "Mendoza",
  "Vasquez",
  "Castillo",
  "Jimenez",
  "Moreno",
  "Romero",
  "Herrera",
  "Medina",
  "Aguilar",
  "Vargas",
  "Guzman",
  "Castro",
  "Fernandez",
  "Munoz",
  "Rojas",
  "Soto",
  "Contreras",
  "Silva",
  "Delgado",
  "Pena",
  "Rios",
  "Salazar",
  "Estrada",
  "Ortega",
  "Nunez",
  "Maldonado",
  "Vega",
  "Dominguez",
  "Cabrera",
  "Velasquez",
  "Ibarra",
  "Zavala",
  "Cervantes",
  "Fuentes",
  "Carrillo",
  "Trejo",
  "Solis",
  "Cardenas",
  "Villanueva",
  "Escobar",
  "Quintero",
  "Barrera",
  "Rosales",
  "Camacho",
  "Arellano",
  "Meza",
  "Palacios",
  "Navarro",
  "Padilla",
  "Miranda",
  "Bautista",
  "Orozco",
  "Zuniga",
  "Ochoa",
  "Duran",
  "Macias",
  "Renteria",
] as const

/** Display names only: handles and emails stay ASCII. */
export const ACCENTED: Record<string, string> = {
  Jose: "José",
  Maria: "María",
  Jesus: "Jesús",
  Andres: "Andrés",
  Cesar: "César",
  Angel: "Ángel",
  Lucia: "Lucía",
  Sofia: "Sofía",
  Ivan: "Iván",
  Fatima: "Fátima",
  Munoz: "Muñoz",
  Nunez: "Núñez",
  Pena: "Peña",
  Zuniga: "Zúñiga",
}

export const OTHER_POOLS: readonly {
  firstM: readonly string[]
  firstF: readonly string[]
  last: readonly string[]
  weight: number
}[] = [
  {
    // Korean American
    firstM: ["Daniel", "Brian", "Eric", "Andrew", "Joon", "David"],
    firstF: ["Grace", "Esther", "Hannah", "Julie", "Minji", "Susan"],
    last: ["Kim", "Park", "Lee", "Choi", "Kang", "Yoon", "Shin", "Cho"],
    weight: 5,
  },
  {
    // Armenian American
    firstM: ["Armen", "Narek", "Tigran", "Vahe"],
    firstF: ["Ani", "Lilit", "Mariam", "Sona"],
    last: ["Hakobyan", "Grigoryan", "Sarkissian", "Petrosyan", "Avetisyan", "Kasparian"],
    weight: 3,
  },
  {
    // Filipino American
    firstM: ["Angelo", "Mark", "JR", "Paolo"],
    firstF: ["Kristine", "Joanna", "Camille", "Divine"],
    last: ["Santos", "Dela Cruz", "Mercado", "Aquino", "Ocampo", "Villareal", "Manalo"],
    weight: 4,
  },
  {
    // Black and White American
    firstM: ["Marcus", "Darnell", "James", "Mike", "Tyler", "Jordan", "Chris", "Devin"],
    firstF: ["Keisha", "Tiffany", "Sarah", "Emily", "Aaliyah", "Megan", "Lauren", "Renee"],
    last: [
      "Johnson",
      "Williams",
      "Brown",
      "Smith",
      "Miller",
      "Davis",
      "Jackson",
      "Harris",
      "Thompson",
      "Robinson",
      "Walker",
      "Carter",
      "Mitchell",
      "Turner",
    ],
    weight: 10,
  },
  {
    // Chinese American
    firstM: ["Wei", "Kevin", "Jason", "Alan"],
    firstF: ["Amy", "Cindy", "Michelle", "Tina"],
    last: ["Chen", "Wang", "Liu", "Huang", "Lin", "Wu", "Zhang"],
    weight: 4,
  },
  {
    // Vietnamese American
    firstM: ["Minh", "Vincent", "Phong", "Tuan"],
    firstF: ["Linh", "Thao", "Kim-Ly", "Vy"],
    last: ["Nguyen", "Tran", "Pham", "Le", "Vo", "Dang"],
    weight: 3,
  },
]

// Neighborhood jitter radii are in degrees. Weighted toward the Eastside, Southeast LA and the harbor
// corridor.

export interface Hood {
  name: string
  lat: number
  lng: number
  r: number
  weight: number
  streets: readonly string[]
}

export const HOODS: readonly Hood[] = [
  {
    name: "Boyle Heights",
    lat: 34.0397,
    lng: -118.2077,
    r: 0.01,
    weight: 10,
    streets: [
      "Cesar Chavez Ave",
      "Soto St",
      "1st St",
      "4th St",
      "Whittier Blvd",
      "Lorena St",
      "Evergreen Ave",
      "St Louis St",
    ],
  },
  {
    name: "East LA",
    lat: 34.0239,
    lng: -118.1721,
    r: 0.012,
    weight: 9,
    streets: ["Whittier Blvd", "Atlantic Blvd", "3rd St", "Mednik Ave", "Arizona Ave", "Hammel St"],
  },
  {
    name: "Highland Park",
    lat: 34.1115,
    lng: -118.187,
    r: 0.01,
    weight: 7,
    streets: ["York Blvd", "Figueroa St", "Avenue 56", "Monte Vista St", "Marmion Way"],
  },
  {
    name: "El Sereno",
    lat: 34.0806,
    lng: -118.1763,
    r: 0.01,
    weight: 6,
    streets: ["Huntington Dr", "Eastern Ave", "Alhambra Ave", "Valley Blvd"],
  },
  {
    name: "Lincoln Heights",
    lat: 34.07,
    lng: -118.2,
    r: 0.008,
    weight: 6,
    streets: ["N Broadway", "Daly St", "Main St", "Avenue 26", "Workman St"],
  },
  {
    name: "City Terrace",
    lat: 34.057,
    lng: -118.183,
    r: 0.007,
    weight: 4,
    streets: ["City Terrace Dr", "Eastern Ave", "Herbert Ave"],
  },
  {
    name: "Huntington Park",
    lat: 33.9817,
    lng: -118.2251,
    r: 0.009,
    weight: 7,
    streets: ["Pacific Blvd", "Gage Ave", "Slauson Ave", "Florence Ave", "Santa Fe Ave"],
  },
  {
    name: "South Gate",
    lat: 33.9547,
    lng: -118.212,
    r: 0.01,
    weight: 5,
    streets: ["Tweedy Blvd", "Long Beach Blvd", "Firestone Blvd", "Atlantic Ave"],
  },
  {
    name: "Pacoima",
    lat: 34.2728,
    lng: -118.4201,
    r: 0.012,
    weight: 6,
    streets: ["Van Nuys Blvd", "Glenoaks Blvd", "Laurel Canyon Blvd", "Foothill Blvd", "Paxton St"],
  },
  {
    name: "Van Nuys",
    lat: 34.1899,
    lng: -118.4514,
    r: 0.012,
    weight: 5,
    streets: ["Van Nuys Blvd", "Victory Blvd", "Sherman Way", "Sepulveda Blvd", "Kester Ave"],
  },
  {
    name: "Sylmar",
    lat: 34.3078,
    lng: -118.4453,
    r: 0.012,
    weight: 3,
    streets: ["San Fernando Rd", "Maclay Ave", "Glenoaks Blvd", "Hubbard St"],
  },
  {
    name: "Sun Valley",
    lat: 34.217,
    lng: -118.37,
    r: 0.01,
    weight: 3,
    streets: ["San Fernando Rd", "Sunland Blvd", "Vineland Ave", "Lankershim Blvd"],
  },
  {
    name: "Wilmington",
    lat: 33.7801,
    lng: -118.2646,
    r: 0.01,
    weight: 5,
    streets: ["Avalon Blvd", "Anaheim St", "Pacific Coast Hwy", "Wilmington Blvd", "L St"],
  },
  {
    name: "San Pedro",
    lat: 33.7361,
    lng: -118.2922,
    r: 0.01,
    weight: 4,
    streets: ["Gaffey St", "Pacific Ave", "25th St", "Western Ave", "6th St"],
  },
  {
    name: "Watts",
    lat: 33.9425,
    lng: -118.2417,
    r: 0.008,
    weight: 5,
    streets: ["103rd St", "Central Ave", "Compton Ave", "Wilmington Ave", "Grandee Ave"],
  },
  {
    name: "South LA",
    lat: 34.0,
    lng: -118.292,
    r: 0.014,
    weight: 7,
    streets: [
      "Vermont Ave",
      "Western Ave",
      "Normandie Ave",
      "Slauson Ave",
      "Manchester Ave",
      "Figueroa St",
    ],
  },
  {
    name: "Koreatown",
    lat: 34.0577,
    lng: -118.3009,
    r: 0.009,
    weight: 5,
    streets: [
      "Wilshire Blvd",
      "Olympic Blvd",
      "Western Ave",
      "Vermont Ave",
      "8th St",
      "Normandie Ave",
    ],
  },
  {
    name: "Westlake",
    lat: 34.057,
    lng: -118.276,
    r: 0.007,
    weight: 5,
    streets: ["Alvarado St", "7th St", "Wilshire Blvd", "Union Ave", "Bonnie Brae St"],
  },
  {
    name: "Pico-Union",
    lat: 34.047,
    lng: -118.283,
    r: 0.007,
    weight: 5,
    streets: ["Pico Blvd", "Union Ave", "Hoover St", "Venice Blvd", "Alvarado St"],
  },
  {
    name: "Cypress Park",
    lat: 34.093,
    lng: -118.224,
    r: 0.006,
    weight: 3,
    streets: ["Cypress Ave", "Figueroa St", "San Fernando Rd", "Division St"],
  },
  {
    name: "Glassell Park",
    lat: 34.113,
    lng: -118.232,
    r: 0.007,
    weight: 3,
    streets: ["Eagle Rock Blvd", "Verdugo Rd", "San Fernando Rd", "Fletcher Dr"],
  },
  {
    name: "Echo Park",
    lat: 34.0782,
    lng: -118.2606,
    r: 0.007,
    weight: 4,
    streets: ["Sunset Blvd", "Echo Park Ave", "Glendale Blvd", "Alvarado St"],
  },
  {
    name: "Hollywood",
    lat: 34.0928,
    lng: -118.3287,
    r: 0.01,
    weight: 3,
    streets: ["Hollywood Blvd", "Sunset Blvd", "Santa Monica Blvd", "Western Ave", "Gower St"],
  },
  {
    name: "North Hollywood",
    lat: 34.172,
    lng: -118.377,
    r: 0.01,
    weight: 4,
    streets: ["Lankershim Blvd", "Magnolia Blvd", "Victory Blvd", "Vineland Ave"],
  },
  {
    name: "Panorama City",
    lat: 34.227,
    lng: -118.449,
    r: 0.009,
    weight: 4,
    streets: ["Van Nuys Blvd", "Roscoe Blvd", "Nordhoff St", "Woodman Ave"],
  },
  {
    name: "Harbor Gateway",
    lat: 33.86,
    lng: -118.29,
    r: 0.01,
    weight: 2,
    streets: ["Vermont Ave", "Figueroa St", "Gardena Blvd", "190th St"],
  },
]

export const PARKS: readonly { name: string; hood: string; lat: number; lng: number }[] = [
  { name: "Hollenbeck Park", hood: "Boyle Heights", lat: 34.0367, lng: -118.2135 },
  { name: "Ruben Salazar Park", hood: "East LA", lat: 34.0236, lng: -118.1893 },
  { name: "Salt Lake Park", hood: "Huntington Park", lat: 33.9757, lng: -118.2172 },
  { name: "Hazard Park", hood: "Boyle Heights", lat: 34.0645, lng: -118.2005 },
  { name: "Lincoln Park", hood: "Lincoln Heights", lat: 34.0705, lng: -118.2028 },
  { name: "Sycamore Grove Park", hood: "Highland Park", lat: 34.0996, lng: -118.1998 },
  { name: "Ted Watkins Memorial Park", hood: "Watts", lat: 33.933, lng: -118.2379 },
  { name: "MacArthur Park", hood: "Westlake", lat: 34.059, lng: -118.2785 },
  { name: "Rio de Los Angeles State Park", hood: "Cypress Park", lat: 34.0994, lng: -118.2273 },
  { name: "Ernest E. Debs Regional Park", hood: "El Sereno", lat: 34.0873, lng: -118.1935 },
  { name: "Ken Malloy Harbor Regional Park", hood: "Wilmington", lat: 33.7863, lng: -118.2879 },
  { name: "Hansen Dam Recreation Area", hood: "Pacoima", lat: 34.2612, lng: -118.3898 },
  { name: "Sepulveda Basin", hood: "Van Nuys", lat: 34.1755, lng: -118.4838 },
  { name: "Point Fermin Park", hood: "San Pedro", lat: 33.706, lng: -118.2936 },
  { name: "Normandie Recreation Center", hood: "South LA", lat: 34.0261, lng: -118.3003 },
  { name: "Seoul International Park", hood: "Koreatown", lat: 34.0546, lng: -118.3082 },
  { name: "North Hollywood Park", hood: "North Hollywood", lat: 34.1638, lng: -118.3801 },
  { name: "Echo Park Lake", hood: "Echo Park", lat: 34.0723, lng: -118.2606 },
]

export function hoodByName(name: string): Hood {
  return HOODS.find((h) => h.name === name) ?? HOODS[0]!
}

// Deliberately casual: lowercase drift, loose punctuation, Spanish and Spanglish mixed in, occasional
// emoji, no long-form writing and no em dashes anywhere (validate() enforces the last).

export const BIO_NEUTRAL: readonly string[] = [
  "{hood} born and raised",
  "trying to keep {hood} clean one block at a time",
  "east side til i die",
  "community first. {hood}",
  "if you see me picking up trash say hi",
  "small business owner on {street}",
  "youth soccer coach in {hood}",
  "keeping it clean in {hood} 🧹",
  "born in {hood}, still here, not leaving",
  "retired LAUSD. love my neighborhood",
  "just here to report potholes tbh",
  "organizing cleanups w my neighbors. dm me if you wanna help",
  "{hood} neighborhood watch",
]

export const BIO_MALE: readonly string[] = [
  "dad of 3. tired of the dumping on our streets",
  "girl dad in {hood}",
  "dog dad, {hood}",
]
export const BIO_FEMALE: readonly string[] = [
  "mom of 3. tired of the dumping on our streets",
  "{hood} resident, dog mom, 311 power user",
  "abuela energy. {hood}",
]

/** Only for Hispanic users; vecino/vecina gendered. */
export const BIO_HISPANIC_NEUTRAL: readonly string[] = [
  "orgullosamente de {hood} 🇲🇽",
  "aqui puro {hood} 💪",
  "la comunidad es todo",
]
export const BIO_HISPANIC_M: readonly string[] = ["vecino de {hood}, aqui para ayudar"]
export const BIO_HISPANIC_F: readonly string[] = ["vecina de {hood}, aqui para ayudar"]

/** {street}/{street2}/{hood} slots are filled per author. */
export const POST_TEMPLATES_EN: readonly string[] = [
  "third couch this month dumped on {street}. who keeps doing this",
  "the graffiti on the handball courts finally got painted over 🙏",
  "somebody left a whole entertainment center on the corner of {street} and {street2} lol",
  "shoutout to the crew that cleaned the alley behind {street} this weekend. looks brand new",
  "when is the city gonna fix the streetlight on {street}, its been out for like 2 months",
  "reported a mattress on {street} last tuesday and they actually picked it up friday. not bad",
  "ok whoever keeps dumping tires by the wash, we see you 🤨",
  "morning walk update: {street} is looking clean for once. small wins",
  "the bulky item pickup line had me on hold 40 mins. this app is way faster",
  "we need more trash cans on {street} near the bus stop. overflowing every weekend",
  "just moved to {hood} and joined this app, love seeing neighbors actually fix stuff",
  "anyone else notice the illegal dumping gets worse right after the first of the month",
  "picked up 3 bags on my street this morning before work. tired but worth it",
  "the mural on {street} got tagged again 😔 gonna organize a repaint",
  "city came and cleared the {street} underpass today. hope it stays clean this time",
  "psa: bulky item pickup is free, you dont have to dump your sofa on {street} 😤",
  "not all heroes wear capes, some just bring their own trash grabbers",
  "the sidewalk on {street} is basically an obstacle course. reported like 4 spots today",
  "my kids and i picked up trash at the park today. teach em young",
  "10/10 morning, coffee from the panaderia and a clean street for once",
  "does anyone know who to talk to about the abandoned car on {street}, been there 3 weeks",
  "the amount of fast food trash on {street} after friday night is wild",
  "shout out to the senora on my block who sweeps the whole sidewalk every morning",
  "found a shopping cart in the LA river again. classic",
  "neighbors really came through this weekend, {street} is spotless",
  "why do people dump paint cans in the alley. thats toxic waste man",
  "councilman's office actually called me back about the {street} dumping. progress??",
  "the little free library on {street} survived another year 🥹 love this block",
  "somebody stole the trash can from the bus stop?? lol only in LA",
  "green waste everywhere after the wind last night. be careful driving on {street}",
  "im convinced the same truck dumps on {street} every sunday night. gonna get a plate next time",
  "starting to see more people use this app in {hood}. keep reporting yall, it works",
  "cleaned up the parkway strip in front of my house. do your part people",
  "walking to the market and counted 6 illegal dump spots on {street}. all reported",
  "our block finally got the speed humps. now if we could get the trash handled",
  "sunday morning cleanups hit different. peaceful out here",
  "reminder that the storm drains go straight to the ocean. keep em clear",
  "big respect to the folks who do this every single week without any credit",
  "the empty lot on {street} needs some love, thinking of organizing something",
  "trash pickup skipped our street again this week?? anyone else on {street}",
  "if every block had 2 people who cared we could keep this whole neighborhood clean",
]

/** Drawn only by Hispanic authors. */
export const POST_TEMPLATES_ES: readonly string[] = [
  "mucha basura en la calle otra vez. ya reporte, a ver si hacen algo",
  "el alley behind my place is getting bad again, gonna report it manana",
  "gracias a todos los que vinieron hoy, quedo bien limpio el parque 💪",
  "los fines de semana la gente tira basura como si nada. respeten el barrio",
  "vamos a limpiar {hood} este sabado, quien se apunta",
  "cada quien su bolsa. sabado 9am. no excuses",
  "hoy tocó limpiar la esquina de {street}. entre 4 lo hicimos en una hora",
  "esta app si funciona, reporte un colchon y en 3 dias lo recogieron",
  "que bonito se ve {hood} cuando todos ayudamos",
]

export const REPORT_POST_EN: readonly string[] = [
  "reported this dump on {street}, yall check it out so the city sees it",
  "this has been here over a week. finally reported it",
  "look at this mess. reported. lets see how long it takes",
  "reported this one this morning, right by the school 😡",
  "adding this to the pile of reports on {street}. its bad out here",
  "cant even use the sidewalk. reported",
  "this is right in front of the panaderia. reported it, share so it gets fixed",
  "week 2 of this couch. reported again lol",
  "who does this?? reported",
]
export const REPORT_POST_ES: readonly string[] = [
  "como es posible que dejen esto asi. ya lo reporte",
  "miren esto. reportado. compartan para que lo vean",
]

export const EVENT_POST_EN: readonly string[] = [
  "hosting a cleanup this weekend, bring gloves if you got em. everyone welcome",
  "cleanup this saturday 🧹 kids welcome, we got extra grabbers",
  "we're doing another one. last time we filled 20 bags, lets beat that",
  "first cleanup im organizing, be nice lol. hope to see some of you there",
  "join us saturday morning, coffee and pan dulce for volunteers ☕",
  "one more cleanup before it gets too hot. roll thru",
  "big one this weekend. bring the whole family",
]
export const EVENT_POST_ES: readonly string[] = [
  "vamos a limpiar este sabado, traigan agua y guantes. los espero",
  "este sabado nos toca limpiar. lleguenle con la familia",
]

export const EVENT_RECAP_EN: readonly string[] = [
  "{bags} bags today. arms are dead but the block looks brand new. thank you everyone 🙏",
  "we got {bags} bags out of the park today. proud of this neighborhood",
  "another one done. {bags} bags, a couch, and somehow a car bumper lol. great turnout",
  "small crew today but we still pulled {bags} bags. every bit counts",
  "thank you to the {n} people who showed up today. {bags} bags collected",
]
export const EVENT_RECAP_ES: readonly string[] = [
  "{bags} bolsas hoy!! gracias a todos los que vinieron 💪",
  "terminamos con {bags} bolsas. gracias a mi gente que llego temprano",
]

export const REPLY_GENERIC_EN: readonly string[] = [
  "same thing on my street",
  "reported one like this last week, took 3 weeks but they picked it up",
  "this is why i love this app",
  "311 never picks up, this is faster fr",
  "ugh not again",
  "facts",
  "thank you for doing this",
  "we appreciate you 🙏",
  "same in {hood} honestly",
  "its been like this for weeks",
  "somebody has to say it",
  "100%",
  "we need cameras out there",
  "the city needs to do better",
  "keep us posted",
  "this made my day",
  "couldnt agree more",
  "im telling my landlord about this app lol",
  "the real MVP",
  "on my way to report the one by my house too",
  "hope they fix it soon",
  "lmk if you need help",
  "this block deserves better",
  "seen it, its worse in person",
]
export const REPLY_GENERIC_ES: readonly string[] = [
  "gracias por reportar 🙏",
  "el respeto al barrio empieza por uno mismo",
  "asi es",
  "no manches",
  "que bueno que alguien hace algo",
  "orale, buen trabajo",
]

export const REPLY_EVENT_EN: readonly string[] = [
  "i'll be there",
  "count me in",
  "what time does it start?",
  "can i bring my kids?",
  "do we need to bring our own gloves",
  "just signed up 🙌",
  "cant make this one but next time for sure",
  "bringing 2 friends",
  "is there parking nearby",
  "see you saturday",
  "my whole family is coming lol",
  "first time doing one of these, excited",
]
export const REPLY_EVENT_ES: readonly string[] = [
  "yo tambien voy",
  "ahi estare",
  "llevare bolsas extra",
]

export const REPLY_REPORT_EN: readonly string[] = [
  "just liked it so it gets visibility",
  "reported the same spot last month, they cleared it but it came back",
  "thats right by my kids school 😡",
  "share it in the group chat too",
  "the city cleared one like this on my street in about a week",
  "took a pic of the same pile yesterday, glad you reported",
  "this intersection is always bad",
  "sad that it takes an app for the city to do their job",
]
export const REPLY_REPORT_ES: readonly string[] = [
  "eso esta a una cuadra de mi casa",
  "gracias vecino",
]

export const QUOTE_EN: readonly string[] = [
  "this right here",
  "everyone in {hood} needs to see this",
  "and people say nobody cares about this neighborhood",
  "sharing for the morning crowd",
  "this is the kind of stuff that keeps me on this app",
  "proof that reporting works yall",
]
export const QUOTE_ES: readonly string[] = ["lo que siempre digo", "mi gente 💪"]

/** [titles, descriptions]; slots: {street} {street2}. */
export const REPORT_CONTENT: Record<
  ReportType,
  { titles: readonly string[]; descs: readonly string[]; descsEs?: readonly string[] }
> = {
  dump: {
    titles: [
      "mattress dumped on {street}",
      "couch left on the corner of {street} and {street2}",
      "pile of construction debris on {street}",
      "tv and boxes dumped by the alley",
      "furniture dumped on the sidewalk",
      "trash bags piling up on {street}",
      "tires dumped near {street}",
      "someone dumped a washer on {street}",
      "big pile of junk on the parkway",
      "shopping carts and trash on {street}",
    ],
    descs: [
      "been here over a week now. right in front of the laundromat. kids have to walk around it into the street",
      "keeps growing every day. started as one bag now its a whole pile",
      "someone dumped this overnight. blocking half the sidewalk",
      "third time this month at this exact spot. we need a camera or something",
      "smells terrible and there are flies everywhere. please pick up soon",
      "right next to the bus stop where people wait every morning",
      "wood with nails sticking out, dangerous for kids walking to school",
      "looks like a contractor dumped it, there are paint buckets and drywall",
      "elderly neighbors cant get around it with their carts",
      "its right by the storm drain, gonna wash into the river when it rains",
    ],
    descsEs: [
      "esta enfrente de mi casa desde el lunes. ya no podemos ni pasar por la banqueta",
      "la gente sigue tirando basura aqui, cada semana es lo mismo",
    ],
  },
  graffiti: {
    titles: [
      "tagging on the wall at {street}",
      "graffiti on the bus bench",
      "fresh tags on the store shutters",
      "graffiti covering the street sign",
      "wall on {street} tagged again",
      "tags all over the underpass",
    ],
    descs: [
      "whole wall got hit over the weekend. was just painted 2 months ago",
      "the stop sign is barely readable now, thats a safety issue",
      "small business owner already dealing with a lot, now this",
      "gang tags this time, neighbors are worried. please prioritize",
      "they tagged the mural too which is really sad, that mural took months",
      "same tags as the ones on {street2}, probably the same people",
    ],
    descsEs: ["rayaron toda la pared otra vez. apenas la habian pintado"],
  },
  encampment: {
    titles: [
      "encampment growing under the {street} overpass",
      "tents blocking the sidewalk on {street}",
      "encampment by the wash near {street}",
    ],
    descs: [
      "not trying to get anyone in trouble, they need services. but the sidewalk is fully blocked and theres a lot of debris",
      "its grown from 2 tents to about 8 in a month. trash is piling up around it",
      "requesting outreach services, theres an older man there who needs medical help",
      "kids walk this route to school and have to go into the street",
    ],
  },
  infrastructure: {
    titles: [
      "broken sprinkler flooding the sidewalk on {street}",
      "fire hydrant leaking on {street}",
      "water main leaking into the street",
      "broken streetlight on {street}",
      "exposed wiring on the light pole",
    ],
    descs: [
      "water has been running down the gutter for 3 days straight. huge waste",
      "the whole corner is flooded every morning. slipping hazard",
      "light has been out for weeks, its really dark on this block at night. safety issue",
      "you can hear the water hissing, probably losing hundreds of gallons",
    ],
    descsEs: ["el poste tiene cables colgando, esta peligroso"],
  },
  pavement: {
    titles: [
      "huge pothole on {street}",
      "sidewalk buckled by tree roots on {street}",
      "pothole damaging cars near {street} and {street2}",
      "cracked curb ramp on the corner",
      "street cracking apart on {street}",
    ],
    descs: [
      "hit it last night, almost lost a tire. its deep",
      "my neighbor in a wheelchair literally cannot use this sidewalk",
      "gets worse every week, and cars swerve into the other lane to miss it",
      "seniors trip here all the time, someone fell last week",
      "been reported before and patched but the patch is already gone",
    ],
    descsEs: ["el bache esta enorme, ya varios carros se han danado"],
  },
  vegetation: {
    titles: [
      "overgrown weeds blocking the sidewalk on {street}",
      "dead palm fronds hanging over {street}",
      "tree branch about to fall on {street}",
      "brush pile fire hazard by {street}",
    ],
    descs: [
      "the weeds are shoulder height, you cant see around the corner when driving",
      "big dead frond hanging right over the bus stop. someone is gonna get hurt",
      "branch cracked in the wind last week and is hanging by a thread",
      "dry brush right up against the fence, one spark and its a problem",
    ],
    descsEs: ["las ramas ya tapan toda la banqueta"],
  },
  other: {
    titles: [
      "abandoned car on {street}",
      "shopping carts collecting on the corner",
      "broken glass all over the sidewalk",
      "dead animal on {street}",
      "leaking dumpster behind the businesses",
    ],
    descs: [
      "hasnt moved in 3 weeks, flat tires, windows are smashed now",
      "at least 6 carts from the ranch market piling up",
      "please send someone, its been days and it smells really bad",
      "someone smashed bottles all over, dogs and kids walk here",
      "grease and trash water running into the gutter",
    ],
  },
}

export const EVENT_TITLE_EN: readonly string[] = [
  "{park} cleanup",
  "{hood} community cleanup",
  "{street} alley cleanup",
  "adopt-a-block {hood}",
  "{hood} saturday sweep",
]
export const EVENT_TITLE_ES: readonly string[] = ["limpieza comunitaria en {park}"]

export const EVENT_DESC_EN: readonly string[] = [
  "meet at the main entrance. we'll split into teams and cover the park and the streets around it. bags and some grabbers provided, bring gloves and water if you can",
  "monthly cleanup with the neighbors. all ages welcome, we usually finish by noon and someone always brings tamales",
  "the alley has gotten bad again so we're getting a crew together. wear closed toe shoes, there might be glass",
  "quick 2 hour cleanup then tacos after for whoever can stay. first timers welcome, we'll show you the ropes",
  "bringing the community together to take care of our space. supplies provided by the neighborhood council",
]
export const EVENT_DESC_ES: readonly string[] = [
  "juntandonos para limpiar el parque y las calles de alrededor. traigan guantes si tienen, nosotros ponemos las bolsas",
]

export const BRING_POOL: readonly string[] = [
  "gloves",
  "water",
  "sunscreen",
  "hat",
  "trash grabbers",
  "closed toe shoes",
  "reusable water bottle",
]

export const SLOT_SETS: readonly (readonly {
  title: string
  description: string | null
  capacity: number | null
}[])[] = [
  [
    {
      title: "Registration table",
      description: "check people in and hand out supplies",
      capacity: 2,
    },
    { title: "Supplies and water", description: "keep the water station stocked", capacity: 2 },
    { title: "Street team", description: "cover the blocks around the park", capacity: null },
  ],
  [
    { title: "8-10am shift", description: null, capacity: 12 },
    { title: "10-12 shift", description: null, capacity: 12 },
  ],
  [
    {
      title: "Heavy lifting crew",
      description: "for the big stuff, bring work gloves",
      capacity: 6,
    },
    { title: "General cleanup", description: null, capacity: null },
    { title: "Kids zone", description: "light duty for families with little ones", capacity: 8 },
  ],
]

export const TIMELINE_ACK_NOTES: readonly string[] = [
  "Forwarded to LA Sanitation",
  "Routed to the responsible department",
  "Received by the city, reference logged",
]
export const TIMELINE_RESOLVE_NOTES: readonly string[] = [
  "Crew confirmed pickup complete",
  "Marked resolved after site inspection",
  "Cleared by sanitation crew",
]
